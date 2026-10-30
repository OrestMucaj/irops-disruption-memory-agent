"""
Synthesises the mouse click and the split-flap board in public/sfx/, so they
are reproducible and carry no third-party licence. numpy only. (whoosh.wav, the
scene transition, is filtered noise and is not regenerated here.)

    python3 scripts/sfx.py

click.wav   A mouse button: the micro-switch snapping down, then its lighter
            release 0.11 s later. Modal synthesis: a sharp excitation ringing
            the switch leaf and the plastic shell, plus a faint body knock.
flaps.wav   The hook's split-flap board, built from the board's own schedule
            (HookScene.tsx). Each of its 196 characters is a module with its
            own pitch, panned by column. Distinct clacks come from the modules
            still turning, about 48 a second at first and thinning as rows
            settle, and the last characters land on their own settle frames.
            A small room gives them space, so there is no dead air between.

Both are written as 48 kHz, 16-bit stereo WAV.
"""

import wave
from pathlib import Path

import numpy as np

SR = 48_000
FPS = 30
OUT = Path(__file__).resolve().parent.parent / 'public' / 'sfx'
rng = np.random.default_rng(20261030)


def write(name: str, stereo: np.ndarray, peak_db: float) -> None:
    stereo = stereo * (10 ** (peak_db / 20) / np.abs(stereo).max())
    pcm = (np.clip(stereo, -1, 1) * 32767).astype('<i2')
    with wave.open(str(OUT / name), 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    print(f'{name}: {len(stereo) / SR:.2f} s')


def highpass(x: np.ndarray, fc: float) -> np.ndarray:
    """One-pole high-pass."""
    a = 1 / (1 + 2 * np.pi * fc / SR)
    y = np.zeros_like(x)
    for n in range(1, len(x)):
        y[n] = a * (y[n - 1] + x[n] - x[n - 1])
    return y


def impact(n: int, freqs, taus, amps, snap: float, snap_fc: float, body=None) -> np.ndarray:
    """A struck object: damped modes with a ~0.1 ms rise, a high-passed noise snap, an optional body knock."""
    t = np.arange(n) / SR
    rise = 1 - np.exp(-t / 0.0001)
    y = np.zeros(n)
    for f, tau, a in zip(freqs, taus, amps):
        y += a * np.exp(-t / tau) * np.sin(2 * np.pi * f * t + rng.uniform(0, 2 * np.pi))
    y *= rise
    noise = rng.standard_normal(n) * np.exp(-t / 0.0004)
    y += snap * highpass(noise, snap_fc)
    if body:
        f, tau, a = body
        y += a * (1 - np.exp(-t / 0.0006)) * np.exp(-t / tau) * np.sin(2 * np.pi * f * t)
    return y


def mouse_click() -> np.ndarray:
    n = int(0.22 * SR)
    y = np.zeros(n)
    down = impact(
        int(0.06 * SR),
        freqs=[1380, 2240, 3170, 4380, 5900, 8200],
        taus=[0.007, 0.005, 0.0038, 0.0028, 0.002, 0.0012],
        amps=[0.30, 0.65, 1.0, 0.75, 0.45, 0.22],
        snap=0.55,
        snap_fc=3000,
        body=(190, 0.005, 0.22),
    )
    up = 0.5 * impact(
        int(0.05 * SR),
        freqs=[1530, 2490, 3520, 4860, 6550, 9100],
        taus=[0.0053, 0.0038, 0.0029, 0.0021, 0.0015, 0.0009],
        amps=[0.30, 0.65, 1.0, 0.75, 0.45, 0.22],
        snap=0.4,
        snap_fc=3500,
        body=(210, 0.005, 0.08),
    )
    at_down, at_up = int(0.002 * SR), int(0.114 * SR)
    y[at_down : at_down + len(down)] += down
    y[at_up : at_up + len(up)] += up
    return np.stack([y, y], axis=1)


# The hook's board, as HookScene.tsx draws it: [time, flight, from, to, delay].
BOARD = [
    ('06:00', 'ZZ1912', 'BRU', 'AMS', 352),
    ('08:50', 'ZZ2052', 'LHR', 'ORD', 86),
    ('14:15', 'ZZ1137', 'CDG', 'OSL', 190),
    ('18:00', 'ZZ4004', 'CDG', 'HEL', 75),
    ('18:35', 'ZZ2852', 'JFK', 'FRA', 180),
    ('18:40', 'ZZ4071', 'AMS', 'VIE', 104),
    ('20:55', 'ZZ3043', 'FRA', 'EDI', 259),
]
HERO = 2


def board_modules():
    """(column, settle time in seconds) for every character that flips, per FlapText."""
    for i, (time, flight, origin, dest, delay) in enumerate(BOARD):
        base = 4 + i * 4 + (14 if i == HERO else 0)
        fields = [(time, 0), (flight, 5), (origin, 11), (dest, 14), (f'DELAYED +{delay}'.ljust(12), 17)]
        for text, col0 in fields:
            for k, ch in enumerate(text):
                if ch != ' ':
                    col = col0 + k
                    yield col, (base + col * 0.9) / FPS


def flaps() -> np.ndarray:
    n = int(2.1 * SR)
    out = np.zeros((n, 2))
    clack_n = int(0.03 * SR)
    modules = []
    for col, settle in board_modules():
        pan = np.clip(-0.7 + 1.4 * col / 28 + rng.uniform(-0.08, 0.08), -1, 1)
        modules.append({
            'settle': settle,
            'pitch': rng.uniform(0.9, 1.12),
            'decay': rng.uniform(0.85, 1.15),
            'gains': np.array([np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)]),
        })
    settles = np.array([m['settle'] for m in modules])

    def clack(m, at: float, amp: float, tune: float = 1.0, ring: float = 1.0) -> None:
        p = m['pitch'] * tune * rng.uniform(0.98, 1.02)
        d = m['decay'] * ring
        # Thin flaps: little low-mid (that's where the narration sits), a bright tick on top.
        y = impact(
            clack_n,
            freqs=[480 * p, 1500 * p, 2650 * p, 4300 * p, 6900 * p, 9600 * p],
            taus=[0.0035 * d, 0.0032 * d, 0.0028 * d, 0.0021 * d, 0.0015 * d, 0.0010 * d],
            amps=[0.12, 0.45, 1.0, 0.8, 0.55, 0.35],
            snap=0.7,
            snap_fc=5000,
        )
        s = int(at * SR)
        out[s : s + clack_n] += amp * y[:, None] * m['gains'][None, :]

    # The flutter: distinct clacks at an irregular ~48 a second while the whole
    # board turns, thinning as rows settle. Each is one of the modules still
    # turning, so it sounds from where the letters are still moving.
    t = 0.03
    while True:
        turning = np.flatnonzero(settles > t + 0.02)
        if len(turning) == 0:
            break
        rate = 14 + 34 * len(turning) / len(modules)
        clack(modules[rng.choice(turning)], t, rng.uniform(0.45, 0.85))
        t += rng.uniform(0.6, 1.4) / rate
    # The last characters to land, each on its own settle frame: firmer, a touch lower.
    for i in np.argsort(settles)[-8:]:
        clack(modules[i], settles[i], rng.uniform(0.6, 0.75), tune=0.94, ring=1.3)
    # A small room, decorrelated per channel, about 14 dB under the clacks: space
    # and no dead air, without smearing them into a wash.
    ir_n = int(0.07 * SR)
    t = np.arange(ir_n) / SR
    for c in range(2):
        ir = 0.012 * rng.standard_normal(ir_n) * np.exp(-t / 0.012)
        ir[0] = 1.0
        size = n + ir_n
        out[:, c] = np.fft.irfft(np.fft.rfft(out[:, c], size) * np.fft.rfft(ir, size), size)[:n]
    fade = int(0.05 * SR)
    out[-fade:] *= np.linspace(1, 0, fade)[:, None]
    return out


if __name__ == '__main__':
    write('click.wav', mouse_click(), peak_db=-3)
    write('flaps.wav', flaps(), peak_db=-3)
