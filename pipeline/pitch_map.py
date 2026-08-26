"""Pitch template in meters + homography from detected pitch keypoints to pitch coords.

Keypoint index order matches pitch/convert_labels.py:
  0-9   left side: corner_top, corner_bottom, big_outer_top, big_outer_bottom,
        big_inner_top, big_inner_bottom, small_outer_top, small_outer_bottom,
        small_inner_top, small_inner_bottom
  10-19 right side: same order
  20-23 crossbar ends: left goal l/r, right goal l/r
  24-25 halfway line ends: top, bottom
"""
import cv2
import numpy as np

PITCH_W, PITCH_H = 105.0, 68.0
GOAL_W = 7.32
PEN_D, PEN_W = 16.5, 40.32
GOAL_AREA_D, GOAL_AREA_W = 5.5, 18.32


def _side_kpts(side):
    x0 = 0.0 if side == "left" else PITCH_W
    xi = PEN_D if side == "left" else PITCH_W - PEN_D
    si = GOAL_AREA_D if side == "left" else PITCH_W - GOAL_AREA_D
    pen_y = (PITCH_H - PEN_W) / 2
    goal_y = (PITCH_H - GOAL_AREA_W) / 2
    return [
        (x0, 0.0), (x0, PITCH_H),
        (x0, pen_y), (x0, PITCH_H - pen_y),
        (xi, pen_y), (xi, PITCH_H - pen_y),
        (x0, goal_y), (x0, PITCH_H - goal_y),
        (si, goal_y), (si, PITCH_H - goal_y),
    ]


TEMPLATE = (
    _side_kpts("left")
    + _side_kpts("right")
    + [
        (0.0, PITCH_H / 2 - GOAL_W / 2),
        (0.0, PITCH_H / 2 + GOAL_W / 2),
        (PITCH_W, PITCH_H / 2 - GOAL_W / 2),
        (PITCH_W, PITCH_H / 2 + GOAL_W / 2),
        (PITCH_W / 2, 0.0),
        (PITCH_W / 2, PITCH_H),
    ]
)


def homography_from_keypoints(kpts_xy, kpts_vis, return_mask=False):
    """Map image pixels -> pitch meters from visible keypoints.

    kpts_xy: (26, 2) pixel coords; kpts_vis: (26,) bool/confidence.
    Returns 3x3 matrix (or (matrix, inlier_mask) with return_mask=True),
    or None / (None, None) if fewer than 4 visible.
    """
    src, dst = [], []
    for i, (xy, v) in enumerate(zip(kpts_xy, kpts_vis)):
        if v:
            src.append(xy)
            dst.append(TEMPLATE[i])
    if len(src) < 4:
        return (None, None) if return_mask else None
    H, mask = cv2.findHomography(np.float32(src), np.float32(dst), cv2.RANSAC, 1.5)
    if return_mask:
        return H, mask
    return H


def homography_valid(H, img_w, img_h, support_pts=None):
    """Reject degenerate / poorly-constrained image->pitch homographies.

    Geometric checks: invertible, projects the pitch outline to a convex,
    non-mirrored quad of sane area near the frame. When `support_pts` (the
    template points the fit was actually built from, e.g. RANSAC inliers) is
    given, also require them to span enough of the pitch — a fit extrapolated
    from one small cluster (e.g. only penalty-area corners) is wildly wrong
    everywhere else and must not be trusted.
    """
    if H is None:
        return False
    if not np.all(np.isfinite(H)) or abs(H[2, 2]) < 1e-12:
        return False
    Hn = H / H[2, 2]
    if not np.all(np.isfinite(Hn)):
        return False
    corners = np.float32([[0, 0], [PITCH_W, 0], [PITCH_W, PITCH_H], [0, PITCH_H]]).reshape(-1, 1, 2)
    try:
        proj = cv2.perspectiveTransform(corners, np.linalg.inv(Hn)).reshape(-1, 2)
    except (cv2.error, np.linalg.LinAlgError):
        return False
    if not np.all(np.isfinite(proj)):
        return False
    # convex + non-mirrored: consecutive edge cross products must share a sign
    signs = []
    for i in range(4):
        a, b, c = proj[i], proj[(i + 1) % 4], proj[(i + 2) % 4]
        signs.append((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]))
    if not (all(s > 0 for s in signs) or all(s < 0 for s in signs)):
        return False
    area = 0.5 * abs(sum(proj[i][0] * proj[(i + 1) % 4][1] - proj[(i + 1) % 4][0] * proj[i][1] for i in range(4)))
    if area < 0.005 * img_w * img_h or area > 8.0 * img_w * img_h:
        return False
    cx, cy = proj[:, 0].mean(), proj[:, 1].mean()
    if not (-img_w <= cx <= 2 * img_w and -img_h <= cy <= 2 * img_h):
        return False
    if support_pts is not None and len(support_pts) >= 4:
        pts = np.float32(support_pts)
        span_x = float(pts[:, 0].max() - pts[:, 0].min())
        span_y = float(pts[:, 1].max() - pts[:, 1].min())
        if span_x + span_y < 40.0 or span_x < 15.0:
            return False
    return True


def to_pitch(H, pts_px, limit=500.0):
    """Transform image-pixel points to pitch meters. Returns list of (x, y) or None entries."""
    pts = [(float(x), float(y)) for x, y in pts_px]
    if H is None:
        return [None] * len(pts)
    if not pts:
        return []
    arr = np.float32(pts).reshape(-1, 1, 2)
    out = cv2.perspectiveTransform(arr, H).reshape(-1, 2)
    return [None if (abs(p[0]) > limit or abs(p[1]) > limit) else (float(p[0]), float(p[1])) for p in out]
