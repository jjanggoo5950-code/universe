"""A tiny, dependency-free ASCII solar system animation for the terminal.

Run with:  python solar_system_ascii.py
Keys:     Space pauses, +/- changes speed, Q exits.
"""

from __future__ import annotations

import argparse
import math
import os
import random
import shutil
import sys
import time
from contextlib import contextmanager


RESET = "\x1b[0m"
COLORS = {
    "dim": "\x1b[38;5;240m",
    "star": "\x1b[38;5;245m",
    "blue": "\x1b[38;5;75m",
    "cyan": "\x1b[38;5;117m",
    "green": "\x1b[38;5;78m",
    "red": "\x1b[38;5;203m",
    "orange": "\x1b[38;5;208m",
    "gold": "\x1b[38;5;220m",
    "white": "\x1b[38;5;255m",
    "violet": "\x1b[38;5;141m",
}

# name, orbit radius (x, y), angular speed, initial angle, glyph, color
PLANETS = [
    ("MERCURY", 7.0, 2.4, 1.50, 0.3, "m", "white"),
    ("VENUS", 11.0, 3.7, 1.10, 2.2, "v", "gold"),
    ("EARTH", 15.5, 5.0, 0.82, 4.4, "E", "blue"),
    ("MARS", 20.0, 6.5, 0.65, 1.4, "M", "red"),
    ("JUPITER", 30.0, 9.6, 0.34, 3.5, "<J>", "orange"),
    ("SATURN", 37.5, 12.0, 0.25, 5.0, "=S=", "gold"),
    ("URANUS", 44.0, 14.0, 0.18, 2.6, "{U}", "cyan"),
    ("NEPTUNE", 50.0, 15.5, 0.14, 0.8, "{N}", "violet"),
]


def put(grid, x, y, char, color="star"):
    height, width = len(grid), len(grid[0])
    if 0 <= x < width and 0 <= y < height:
        grid[y][x] = (char, color)


def draw_ellipse(grid, cx, cy, rx, ry, x_scale, y_scale, color="dim"):
    steps = max(100, int(2 * math.pi * rx * x_scale * 2.2))
    for i in range(steps):
        angle = 2 * math.pi * i / steps
        x = round(cx + rx * x_scale * math.cos(angle))
        y = round(cy + ry * y_scale * math.sin(angle))
        put(grid, x, y, ".", color)


def make_frame(width, height, tick, speed, paused, color=True):
    full_legend = "SUN @   MERCURY m   VENUS v   EARTH (E)   MARS M   JUPITER <J>   SATURN =S=   URANUS {U}   NEPTUNE {N}"
    if width >= len(full_legend):
        legend_lines = [full_legend]
    else:
        legend_lines = [
            "SUN @ | MERCURY m | VENUS v | EARTH (E) | MARS M",
            "JUPITER <J> | SATURN =S= | URANUS {U} | NEPTUNE {N}",
        ]
    scene_height = max(1, height - 2 - len(legend_lines) - 1)
    grid = [[(" ", "dim") for _ in range(width)] for _ in range(scene_height)]
    top, bottom = 0, scene_height - 1
    cx, cy = (width - 1) / 2, (top + bottom) / 2
    x_scale = max(0.15, min(1.0, (width / 2 - 2) / 50.0))
    y_scale = max(0.15, min(1.0, (bottom - top) / 2 / 15.5))

    # A fixed star field keeps the scene calm while the planets move.
    rng = random.Random(17)
    for _ in range(max(50, width * height // 24)):
        x, y = rng.randrange(width), rng.randrange(top, bottom + 1)
        put(grid, x, y, rng.choice((".", ".", "+", "*")), "star")

    # Fine orbit lines and the rotating asteroid belt.
    for _, rx, ry, _, _, _, _ in PLANETS:
        draw_ellipse(grid, cx, cy, rx, ry, x_scale, y_scale)
    for i in range(130):
        angle = i * 2.399963 + tick * 0.003
        radius = 24.2 + (i % 13) * 0.19
        x = round(cx + radius * x_scale * math.cos(angle))
        y = round(cy + radius * 0.31 * y_scale * math.sin(angle))
        put(grid, x, y, "," if i % 3 else ";", "gold" if i % 5 == 0 else "dim")

    # The sun has a small, sparkling corona.
    for radius, glyph, shade in ((2.0, ".", "orange"), (1.4, "+", "gold"), (0.8, "*", "gold")):
        for i in range(16):
            angle = i * math.tau / 16 + tick * 0.025
            put(grid, round(cx + radius * math.cos(angle)), round(cy + radius * math.sin(angle)), glyph, shade)
    put(grid, round(cx), round(cy), "@", "white")

    # Orbiting worlds, drawn after the trails so their symbols stay crisp.
    for name, rx, ry, orbital_speed, phase, glyph, shade in PLANETS:
        angle = phase + tick * orbital_speed * 0.012 * speed
        x = round(cx + rx * x_scale * math.cos(angle))
        y = round(cy + ry * y_scale * math.sin(angle))
        if name == "EARTH":
            put(grid, x - 1, y, "(", "blue")
            put(grid, x, y, "E", "green" if tick % 8 < 4 else "blue")
            put(grid, x + 1, y, ")", "blue")
        else:
            start = x - len(glyph) // 2
            for offset, char in enumerate(glyph):
                put(grid, start + offset, y, char, shade)

    title = "S O L A R   S Y S T E M   //   orbiting code"
    subtitle = "A little universe made of letters, light & moving dots"
    controls = f"SPACE {'resume' if paused else 'pause'}   +/- speed ({speed:.1f}x)   Q quit"

    def centered(text):
        return text[:width].center(width)

    lines = [(centered(title), "cyan"), (centered(subtitle), "star")]
    lines.extend((row, None) for row in grid)
    lines.extend((centered(legend), "gold") for legend in legend_lines)
    lines.append((centered(controls), "star"))

    output = []
    if color:
        output.append("\x1b[H")
    for line, line_color in lines:
        if line_color is not None:
            output.append(COLORS[line_color] if color else "")
            output.append(line)
            output.append(RESET if color else "")
        else:
            active = None
            for char, shade in line:
                if color and shade != active:
                    output.append(COLORS[shade])
                    active = shade
                output.append(char)
            if color:
                output.append(RESET)
        if color:
            output.append("\x1b[K")
        output.append("\n")
    return "".join(output)


@contextmanager
def keyboard_mode():
    if os.name == "nt" or not sys.stdin.isatty():
        yield
        return
    import termios
    import tty

    fd = sys.stdin.fileno()
    old_settings = termios.tcgetattr(fd)
    try:
        tty.setcbreak(fd)
        yield
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)


def read_key():
    if os.name == "nt":
        import msvcrt

        if msvcrt.kbhit():
            key = msvcrt.getwch()
            return key.lower() if key else ""
        return ""
    import select

    ready, _, _ = select.select([sys.stdin], [], [], 0)
    return sys.stdin.read(1).lower() if ready else ""


def main():
    parser = argparse.ArgumentParser(description="Watch the solar system orbit in ASCII art.")
    parser.add_argument("--once", action="store_true", help="print one still frame")
    parser.add_argument("--no-color", action="store_true", help="disable ANSI colors")
    args = parser.parse_args()

    terminal = shutil.get_terminal_size((110, 38))
    width = min(110, max(54, terminal.columns))
    height = min(38, max(20, terminal.lines))
    interactive = not args.once and sys.stdin.isatty() and sys.stdout.isatty()
    color = not args.no_color and sys.stdout.isatty()
    speed, paused, tick = 1.0, False, 0

    if not interactive:
        sys.stdout.write(make_frame(width, height, tick, speed, paused, color=color))
        return

    sys.stdout.write("\x1b[2J\x1b[?25l")
    try:
        with keyboard_mode():
            while True:
                key = read_key()
                if key == "q":
                    break
                if key == " ":
                    paused = not paused
                elif key in ("+", "="):
                    speed = min(4.0, speed + 0.2)
                elif key in ("-", "_"):
                    speed = max(0.2, speed - 0.2)
                sys.stdout.write(make_frame(width, height, tick, speed, paused, color=color))
                sys.stdout.flush()
                if not paused:
                    tick += 1
                time.sleep(0.08)
    finally:
        sys.stdout.write("\x1b[0m\x1b[?25h\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()

