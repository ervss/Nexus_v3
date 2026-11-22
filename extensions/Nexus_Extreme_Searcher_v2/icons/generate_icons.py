"""Generate crisp green search icons for the Manifest V3 extension."""

from pathlib import Path

from PIL import Image, ImageDraw


HERE = Path(__file__).resolve().parent
BASE = 1024
GREEN = "#16a34a"
WHITE = "#ffffff"


def icon(size: int) -> None:
    image = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    # The broad green tile stays recognizable against light and dark toolbars.
    draw.rounded_rectangle((0, 0, BASE - 1, BASE - 1), radius=224, fill=GREEN)

    # Search lens and handle share one weight, with generous space at 16 px.
    draw.ellipse((246, 222, 652, 628), outline=WHITE, width=104)
    draw.line((620, 598, 806, 784), fill=WHITE, width=112)
    draw.ellipse((750, 728, 862, 840), fill=WHITE)

    image.resize((size, size), Image.Resampling.LANCZOS).save(HERE / f"search-{size}.png")


for dimension in (16, 32, 48, 128):
    icon(dimension)
