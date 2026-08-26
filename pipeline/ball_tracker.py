"""Constant-velocity Kalman filter for smoothing flickery ball detections.

The ball model misses ~40% of frames (occlusion/tiny object). This tracker predicts
the ball position through missed frames (coasting) and snaps to detections when they
appear, rejecting outlier detections that jump too far from the prediction.
"""
import numpy as np


class BallTracker:
    def __init__(self, conf_threshold=0.3, max_coast=15, gate_px=200.0):
        self.conf_threshold = conf_threshold
        self.max_coast = max_coast
        self.gate_px = gate_px
        self.state = None
        self.cov = None
        self.coast = 0

        self.F = np.array([[1, 0, 1, 0], [0, 1, 0, 1], [0, 0, 1, 0], [0, 0, 0, 1]], dtype=float)
        self.H = np.array([[1, 0, 0, 0], [0, 1, 0, 0]], dtype=float)
        self.Q = np.diag([1.0, 1.0, 0.25, 0.25])
        self.R = np.array([[6.0, 0], [0, 6.0]])

    def _best_detection(self, ball_result):
        """Highest-confidence detection above threshold, as (cx, cy, conf) or None."""
        best = None
        for b in ball_result.boxes:
            conf = float(b.conf)
            if conf < self.conf_threshold:
                continue
            if best is None or conf > best[2]:
                x1, y1, x2, y2 = b.xyxy[0].tolist()
                best = ((x1 + x2) / 2, (y1 + y2) / 2, conf)
        return best

    def _init(self, x, y):
        self.state = np.array([x, y, 0.0, 0.0])
        self.cov = np.diag([25.0, 25.0, 100.0, 100.0])
        self.coast = 0

    def _predict(self):
        self.state = self.F @ self.state
        self.cov = self.F @ self.cov @ self.F.T + self.Q

    def _update(self, x, y):
        z = np.array([x, y])
        innov = z - self.H @ self.state
        S = self.H @ self.cov @ self.H.T + self.R
        K = self.cov @ self.H.T @ np.linalg.inv(S)
        self.state = self.state + K @ innov
        self.cov = (np.eye(4) - K @ self.H) @ self.cov

    def reset(self):
        """Forget all tracking state (call when starting a fresh sequential pass)."""
        self.state = None
        self.cov = None
        self.coast = 0

    def update(self, ball_result):
        """Feed one frame's ball Result; return smoothed position dict or None.

        Returns {'x', 'y', 'coasting', 'conf'} in pixel coords, or None if the
        track is lost (no detection for > max_coast frames).
        """
        det = self._best_detection(ball_result)

        if self.state is None:
            if det is None:
                return None
            self._init(det[0], det[1])
            return {"x": det[0], "y": det[1], "coasting": False, "conf": det[2]}

        self._predict()
        self.coast += 1

        if det is not None:
            dist = float(np.hypot(det[0] - self.state[0], det[1] - self.state[1]))
            if dist <= self.gate_px or self.coast > self.max_coast:
                self._update(det[0], det[1])
                self.coast = 0
                return {"x": float(self.state[0]), "y": float(self.state[1]), "coasting": False, "conf": det[2]}

        if self.coast > self.max_coast:
            self.state = None
            return None
        return {"x": float(self.state[0]), "y": float(self.state[1]), "coasting": True, "conf": 0.0}
