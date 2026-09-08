"""Pinned adapter for KennethJAllen/proper-pixel-art.

Reads one RGBA PNG from stdin and writes the recovered RGBA PNG to stdout.
Diagnostics stay on stderr so the Node caller can keep stdout binary-safe.
"""

from __future__ import annotations

import argparse
from importlib.metadata import version
import sys
from io import BytesIO
from pathlib import Path

from PIL import Image
from proper_pixel_art import pixelate

REQUIREMENTS_PATH = Path(__file__).with_name("proper-pixel-art-requirements.txt")


def assert_dependency_versions() -> None:
    requirements = (
        line.strip()
        for line in REQUIREMENTS_PATH.read_text(encoding="utf-8").splitlines()
    )
    for requirement in requirements:
        if not requirement or requirement.startswith("#"):
            continue
        package, separator, expected = requirement.partition("==")
        if separator != "==" or not package or not expected:
            raise RuntimeError(
                f"invalid pinned requirement in {REQUIREMENTS_PATH.name}: {requirement}"
            )
        actual = version(package)
        if actual != expected:
            raise RuntimeError(
                f"{package}=={expected} is required, but {actual} is installed"
            )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pixel-width", type=int, default=0)
    args = parser.parse_args()

    if args.pixel_width < 0:
        raise ValueError("--pixel-width must be zero (auto-detect) or a positive integer")

    assert_dependency_versions()
    source = Image.open(BytesIO(sys.stdin.buffer.read())).convert("RGBA")
    recovered = pixelate(
        source,
        num_colors=0,
        scale_result=1,
        transparent_background=False,
        pixel_width=args.pixel_width or None,
    )

    # Preserve one output pixel per recovered mesh cell. Re-expanding this
    # native mesh to the source canvas can create non-uniform pixel blocks when
    # the dimensions are not exact multiples. The pipeline's resize module owns
    # the final canvas dimensions.
    recovered.save(sys.stdout.buffer, format="PNG")


if __name__ == "__main__":
    main()
