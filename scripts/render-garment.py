"""CPU seam inspection: python3 scripts/render-garment.py before.json after.json out.png.

Uses actual exported geometry, normals and a shared camera. This is not a WebGL test.
"""
import json
import sys
import numpy as np
from PIL import Image, ImageDraw

W, H = 480, 560


def render(meshes, yaw):
    angle = np.radians(yaw)
    cy, sy = np.cos(angle), np.sin(angle)
    rot = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    body = np.array(meshes[0]['positions']).reshape(-1, 3)
    height = body[:, 1].max()
    center_y = height * (0.38 if any('p_wide_trousers' in m['name'] for m in meshes) else 0.72)
    scale = W / (height * 0.70)
    img = np.ones((H, W, 3)) * np.array([0.96, 0.97, 0.98])
    zbuf = np.full((H, W), -np.inf)
    light = np.array([-0.35, 0.55, 0.8])
    light /= np.linalg.norm(light)
    for mesh in meshes:
        v = np.array(mesh['positions']).reshape(-1, 3) @ rot.T
        n = np.array(mesh['normals']).reshape(-1, 3) @ rot.T
        faces = np.array(mesh['indices']).reshape(-1, 3)
        screen = np.stack([v[:, 0] * scale + W / 2, H / 2 - (v[:, 1] - center_y) * scale, v[:, 2]], axis=1)
        for face in faces:
            p = screen[face]
            x0, x1 = max(0, int(np.floor(p[:, 0].min()))), min(W - 1, int(np.ceil(p[:, 0].max())))
            y0, y1 = max(0, int(np.floor(p[:, 1].min()))), min(H - 1, int(np.ceil(p[:, 1].max())))
            if x1 < x0 or y1 < y0:
                continue
            a, b, c = p
            den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
            if abs(den) < 1e-10:
                continue
            gx, gy = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
            l0 = ((b[1] - c[1]) * (gx - c[0]) + (c[0] - b[0]) * (gy - c[1])) / den
            l1 = ((c[1] - a[1]) * (gx - c[0]) + (a[0] - c[0]) * (gy - c[1])) / den
            l2 = 1 - l0 - l1
            z = l0 * a[2] + l1 * b[2] + l2 * c[2]
            sub = zbuf[y0:y1 + 1, x0:x1 + 1]
            mask = (l0 >= 0) & (l1 >= 0) & (l2 >= 0) & (z > sub)
            if not mask.any():
                continue
            normal = l0[mask, None] * n[face[0]] + l1[mask, None] * n[face[1]] + l2[mask, None] * n[face[2]]
            normal /= np.maximum(np.linalg.norm(normal, axis=1, keepdims=True), 1e-10)
            shade = 0.4 + 0.6 * np.abs(normal @ light)
            img[y0:y1 + 1, x0:x1 + 1][mask] = np.array(mesh['color']) * shade[:, None]
            sub[mask] = z[mask]
    return Image.fromarray((img.clip(0, 1) * 255).astype('uint8'))


if __name__ == '__main__':
    before, after, output = sys.argv[1:]
    sheet = Image.new('RGB', (W * 4, (H + 40) * 2), 'white')
    draw = ImageDraw.Draw(sheet)
    for row, (label, path) in enumerate([('BEFORE', before), ('AFTER', after)]):
        with open(path) as f:
            meshes = json.load(f)
        for col, (name, angle) in enumerate([('Front', 0), ('3/4', 35), ('Side', 90), ('Back', 180)]):
            sheet.paste(render(meshes, angle), (col * W, row * (H + 40) + 40))
            draw.text((col * W + 16, row * (H + 40) + 12), f'{label} / {name}', fill='black')
    sheet.save(output)
    print(output)
