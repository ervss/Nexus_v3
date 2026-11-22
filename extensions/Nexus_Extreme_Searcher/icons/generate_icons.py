"""Generate red search icons for the original Manifest V3 extension."""

from pathlib import Path

from PIL import Image, ImageDraw


HERE = Path(__file__).resolve().parent
BASE = 1024
RED = "#dc2626"
WHITE = "#ffffff"


def icon(size: int) -> None:
    image = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    draw.rounded_rectangle((0, 0, BASE - 1, BASE - 1), radius=224, fill=RED)
    draw.ellipse((246, 222, 652, 628), outline=WHITE, width=104)
    draw.line((620, 598, 806, 784), fill=WHITE, width=112)
    draw.ellipse((750, 728, 862, 840), fill=WHITE)

    image.resize((size, size), Image.Resampling.LANCZOS).save(HERE / f"search-{size}.png")


for dimension in (16, 32, 48, 128):
    icon(dimension)
