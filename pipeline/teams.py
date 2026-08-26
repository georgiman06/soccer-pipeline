"""Automatic team kit-color classification from player bounding boxes.

Each detection's torso crop is reduced to a robust median color (grass-green
pixels masked out) in Lab space. Colors feed a per-sequence online 2-means
model, so the two teams keep stable identities and are rendered in their real
on-pitch kit colors. Detections far from both cluster centers (goalkeepers,
refs, staff) stay unassigned.
"""
import cv2
import numpy as np

MIN_PIXELS = 40           # valid (non-grass) pixels needed to trust a crop color
MIN_COLORS_TO_INIT = 24   # detections collected before the two clusters are seeded
MAX_ASSIGN_DIST = 45.0    # Lab distance above which a detection stays unclassified
CENTER_EMA = 0.04         # center adaptation rate after init (lighting changes)


def jersey_color(frame_bgr, xyxy):
    """Torso color of one player bbox as a Lab vector; None if unusable."""
    if frame_bgr is None:
        return None
    h_img, w_img = frame_bgr.shape[:2]
    x1, y1, x2, y2 = (int(round(v)) for v in xyxy)
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(w_img - 1, x2), min(h_img - 1, y2)
    if x2 - x1 < 4 or y2 - y1 < 8:
        return None
    # torso: upper-middle of the bbox — shirt, not shorts/legs/ground
    crop = frame_bgr[y1 : y1 + int((y2 - y1) * 0.45), x1 + (x2 - x1) // 4 : x1 + 3 * (x2 - x1) // 4]
    if crop.size == 0:
        return None
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    grass = (hsv[..., 0] >= 30) & (hsv[..., 0] <= 95) & (hsv[..., 1] > 60)
    px = crop[~grass]
    if px.shape[0] < MIN_PIXELS:
        px = crop.reshape(-1, 3)
        if px.shape[0] < MIN_PIXELS:
            return None
    med = np.median(px, axis=0).reshape(1, 1, 3).astype(np.uint8)
    return cv2.cvtColor(med, cv2.COLOR_BGR2LAB).reshape(3).astype(np.float32)


class TeamClassifier:
    """Online 2-means over jersey colors; team indices are stable once seeded."""

    def __init__(self):
        self.buffer = []
        self.centers = None  # (2, 3) float32 Lab

    def reset(self):
        self.buffer = []
        self.centers = None

    def observe(self, lab):
        """Feed one detection color; returns 0/1 team index or None."""
        if lab is None:
            return None
        if self.centers is None:
            self.buffer.append(lab)
            if len(self.buffer) >= MIN_COLORS_TO_INIT:
                self._init_centers()
            return None
        d = np.linalg.norm(self.centers - lab, axis=1)
        j = int(np.argmin(d))
        if d[j] > MAX_ASSIGN_DIST:
            return None  # goalkeeper / referee / junk crop
        self.centers[j] = (1.0 - CENTER_EMA) * self.centers[j] + CENTER_EMA * lab
        return j

    def _init_centers(self):
        data = np.float32(np.stack(self.buffer))
        criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 0.5)
        _, _, centers = cv2.kmeans(data, 2, None, criteria, 5, cv2.KMEANS_PP_CENTERS)
        self.centers = centers
        self.buffer = []

    def hex_colors(self):
        """Cluster centers back to BGR hex for rendering; None until seeded."""
        if self.centers is None:
            return None
        out = []
        for c in self.centers:
            # centers live on OpenCV's uint8 Lab scale; cvtColor(float32) would
            # misread them as L in [0,100] / ab in [-127,127] and go near-black
            lab8 = np.uint8(np.clip(np.round(c), 0, 255)).reshape(1, 1, 3)
            bgr = cv2.cvtColor(lab8, cv2.COLOR_LAB2BGR).reshape(3)
            out.append("#%02x%02x%02x" % tuple(int(v) for v in bgr[::-1]))
        return out
