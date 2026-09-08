"""Pinned adapter for KennethJAllen/proper-pixel-art.

Reads one RGBA PNG from stdin and writes the recovered RGBA PNG to stdout.
Diagnostics stay on stderr so the Node caller can keep stdout binary-safe.
"""

from __future__ import annotations

import argparse
import sys
from io import BytesIO

from PIL import Image
from proper_pixel_art import pixelate


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pixel-width", type=int, default=0)
    args = parser.parse_args()

    if args.pixel_width < 0:
        raise ValueError("--pixel-width must be zero (auto-detect) or a positive integer")

    source = Image.open(BytesIO(sys.stdin.buffer.read())).convert("RGBA")
    recovered = pixelate(
        source,
        num_colors=0,
        scale_result=1,
        transparent_background=False,
        pixel_width=args.pixel_width,
    )

    # Mesh recovery changes colour ownership inside the source grid, not the
    # canvas contract. Keep downstream trim/resize as the sole sizing stage.
    recovered.resize(source.size, Image.Resampling.NEAREST).save(
        sys.stdout.buffer, format="PNG"
    )


if __name__ == "__main__":
    main()
