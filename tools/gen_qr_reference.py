#!/usr/bin/env python3
"""Generate tests/fixtures/qr-reference.json from the independent Python
`qrcode` package (byte mode, fixed version/level/mask), so the in-browser QR
encoder can be checked module-for-module against another implementation.

Run once by a developer: python3 tools/gen_qr_reference.py
The app itself never depends on Python or on this package."""
import importlib.metadata
import json
import os

import qrcode
from qrcode.util import QRData, MODE_8BIT_BYTE

LEVELS = {
    "L": qrcode.constants.ERROR_CORRECT_L,
    "M": qrcode.constants.ERROR_CORRECT_M,
    "Q": qrcode.constants.ERROR_CORRECT_Q,
    "H": qrcode.constants.ERROR_CORRECT_H,
}
TEXTS = [
    "j1wl99gzalncqhk052zw07jymxh5qdhr9q2xx3zwjzqeny620sgncqkfyv2z",
    "tj1wl99gzalncqhk052zw07jymxh5qdhr9q2xx3zwjzqeny620sgncqr6m6y3",
    "a",
    "Hello, Jetsam",
    "x" * 120,
    "0123456789" * 21,
]


def matrix(text, level, mask, version=None):
    q = qrcode.QRCode(version=version, error_correction=LEVELS[level],
                      box_size=1, border=0, mask_pattern=mask)
    q.add_data(QRData(text.encode("utf-8"), mode=MODE_8BIT_BYTE))
    q.make(fit=version is None)
    rows = ["".join("1" if m else "0" for m in row) for row in q.modules]
    return q.version, rows


cases = []
for text in TEXTS:
    for level in LEVELS:
        for mask in range(8):
            v, rows = matrix(text, level, mask)
            cases.append({"text": text, "level": level, "mask": mask, "version": v, "rows": rows})
        v, rows = matrix(text, level, None)
        cases.append({"text": text, "level": level, "mask": None, "version": v, "rows": rows})

out = os.path.join(os.path.dirname(__file__), "..", "tests", "fixtures", "qr-reference.json")
with open(out, "w") as f:
    json.dump({"generator": "python qrcode " + importlib.metadata.version("qrcode"), "cases": cases}, f)
print(len(cases), "cases ->", os.path.normpath(out))
