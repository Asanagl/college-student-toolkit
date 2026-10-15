"""Generate the reproducible RC application icon assets."""

from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
RESOURCE_DIR = ROOT / "resources"
APPX_RESOURCE_DIR = RESOURCE_DIR / "appx"


def draw_calendar(draw: ImageDraw.ImageDraw, scale: int) -> None:
    """Draw the calendar shape that remains recognizable at small sizes."""
    blue = (22, 119, 255, 255)
    navy = (11, 61, 145, 255)
    white = (255, 255, 255, 255)
    left, top = 210 * scale, 235 * scale
    right, bottom = 814 * scale, 785 * scale
    draw.rounded_rectangle((left, top, right, bottom), radius=72 * scale, fill=white)
    draw.rounded_rectangle((left, top, right, 390 * scale), radius=72 * scale, fill=navy)
    draw.rectangle((left, 330 * scale, right, 390 * scale), fill=navy)

    ring_y = 190 * scale
    for ring_x in (335, 689):
        draw.rounded_rectangle(
            (ring_x * scale, ring_y, (ring_x + 58) * scale, 300 * scale),
            radius=28 * scale,
            fill=white,
        )

    for row in (485, 610):
        draw.rounded_rectangle(
            (310 * scale, row * scale, 714 * scale, (row + 30) * scale),
            radius=15 * scale,
            fill=blue,
        )
    draw.rounded_rectangle(
        (310 * scale, 690 * scale, 540 * scale, (690 + 30) * scale),
        radius=15 * scale,
        fill=blue,
    )


def draw_book(draw: ImageDraw.ImageDraw, scale: int) -> None:
    """Draw the study-tool mark without text or external font dependencies."""
    navy = (11, 61, 145, 255)
    white = (255, 255, 255, 255)
    draw.rounded_rectangle(
        (585 * scale, 650 * scale, 840 * scale, 870 * scale),
        radius=38 * scale,
        fill=navy,
    )
    draw.polygon(
        [
            (612 * scale, 690 * scale),
            (712 * scale, 720 * scale),
            (812 * scale, 690 * scale),
            (812 * scale, 830 * scale),
            (712 * scale, 800 * scale),
            (612 * scale, 830 * scale),
        ],
        fill=white,
    )
    draw.line(
        (712 * scale, 720 * scale, 712 * scale, 800 * scale),
        fill=navy,
        width=28 * scale,
    )


def draw_icon(size: int) -> Image.Image:
    """Draw the calendar and study-tool mark without text at high resolution."""
    scale = 4
    canvas_size = size * scale
    image = Image.new("RGBA", (canvas_size, canvas_size), (22, 119, 255, 255))
    draw = ImageDraw.Draw(image)
    blue = (22, 119, 255, 255)
    radius = 220 * scale
    draw.rounded_rectangle((0, 0, canvas_size - 1, canvas_size - 1), radius=radius, fill=blue)
    draw_calendar(draw, scale)
    draw_book(draw, scale)
    return image.resize((size, size), Image.Resampling.LANCZOS)


def save_appx_assets(icon: Image.Image) -> None:
    """Create the fixed tile sizes required by the AppX manifest."""
    APPX_RESOURCE_DIR.mkdir(parents=True, exist_ok=True)
    assets = {
        "StoreLogo.png": (50, 50),
        "Square44x44Logo.png": (44, 44),
        "Square71x71Logo.png": (71, 71),
        "Square150x150Logo.png": (150, 150),
        "Square310x310Logo.png": (310, 310),
    }
    for name, size in assets.items():
        icon.resize(size, Image.Resampling.LANCZOS).save(
            APPX_RESOURCE_DIR / name, format="PNG", optimize=True
        )

    wide = Image.new("RGBA", (310, 150), (22, 119, 255, 255))
    tile = icon.resize((150, 150), Image.Resampling.LANCZOS)
    wide.alpha_composite(tile, (80, 0))
    wide.save(APPX_RESOURCE_DIR / "Wide310x150Logo.png", format="PNG", optimize=True)


def main() -> None:
    RESOURCE_DIR.mkdir(parents=True, exist_ok=True)
    icon = draw_icon(1024)
    icon.save(RESOURCE_DIR / "icon.png", format="PNG", optimize=True)
    icon.resize((512, 512), Image.Resampling.LANCZOS).save(
        RESOURCE_DIR / "icon-512.png", format="PNG", optimize=True
    )
    icon.save(
        RESOURCE_DIR / "icon.ico",
        format="ICO",
        sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)],
    )
    save_appx_assets(icon)


if __name__ == "__main__":
    main()
