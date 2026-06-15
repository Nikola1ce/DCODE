# -*- coding: utf-8 -*-
"""
DCODE 提示音合成脚本（一次性工具）。

用途：
    生成一组「Copilot 风格」的柔和、悦耳 WAV 提示音，替代原先单一刺耳的终端 BEL 蜂鸣。
    输出到 assets/sounds/ 下，随构建复制进 dist/assets/sounds/ 并打包分发。

为什么用 WAV：
    本项目是跨平台 CLI。Windows 原生只能可靠播放 WAV（PowerShell System.Media.SoundPlayer），
    OGG 需要用户额外安装播放器，不可靠。故统一用 16-bit PCM 单声道 WAV，
    Windows / macOS(afplay) / Linux(aplay/paplay) 均可零依赖播放。

为什么用 Python 合成而非现成素材：
    本机无 ffmpeg/vlc 等转码工具，无法把 Kenney 的 OGG 转成 WAV；
    且自合成完全可控音色、体积极小（每个文件约几 KB）、零素材依赖、随包分发干净。

设计：
    - 采样率 44100Hz，16-bit，单声道；
    - 每个音由若干「音符」叠加：基频正弦 + 少量谐波（更明亮温暖），
      套用快速淡入 + 指数衰减包络（消除咔哒爆音，听感柔和）；
    - 音高用接近 Copilot/系统提示的清亮中高音区（A4~E6），时长短（<0.5s），不打扰。

运行：
    python scripts/gen-sounds.py
"""

import math
import os
import struct
import wave

# 采样率：CD 音质，足够表现清亮提示音。
SAMPLE_RATE = 44100
# 量化位深：16-bit PCM，SoundPlayer / afplay / aplay 通用。
SAMPLE_WIDTH = 2  # bytes
# 16-bit 有符号 PCM 的最大振幅。
MAX_AMP = 32767

# 输出目录：仓库内 assets/sounds（构建时复制到 dist/assets/sounds）。
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "sounds")


def adsr_envelope(n_samples, attack=0.006, release_ratio=0.9):
    """生成「快速淡入 + 指数衰减」包络数组，长度为 n_samples。

    - attack：淡入时长（秒），很短以消除起始爆音但保留清脆触感；
    - release_ratio：衰减段占比（剩余部分做指数衰减到接近 0），让尾音自然收束。
    返回每个采样点的增益系数（0~1）。
    """
    env = [0.0] * n_samples
    attack_n = max(1, int(SAMPLE_RATE * attack))
    for i in range(n_samples):
        if i < attack_n:
            # 线性淡入。
            env[i] = i / attack_n
        else:
            # 指数衰减：t 从 0→1，增益 e^(-k t)，k 越大衰减越快。
            t = (i - attack_n) / max(1, (n_samples - attack_n))
            env[i] = math.exp(-3.2 * t)
    return env


def render_note(freq, duration, amp=0.6, harmonics=(1.0, 0.28, 0.12)):
    """合成单个音符的浮点波形（-1~1）。

    - freq：基频（Hz）；
    - duration：时长（秒）；
    - amp：整体音量系数（0~1），多音叠加时留足余量防削波；
    - harmonics：各次谐波（1x/2x/3x...）的相对幅度，加少量谐波让音色更明亮温暖。
    """
    n = int(SAMPLE_RATE * duration)
    env = adsr_envelope(n)
    out = [0.0] * n
    for i in range(n):
        t = i / SAMPLE_RATE
        s = 0.0
        for k, h_amp in enumerate(harmonics, start=1):
            s += h_amp * math.sin(2.0 * math.pi * freq * k * t)
        out[i] = s * env[i] * amp
    return out


def mix_sequence(notes):
    """把一串 (freq, duration, start_delay, amp) 音符按起始时间叠加成一条波形。

    - start_delay：该音符相对整段起点的延迟（秒），用于做「琶音/双音」的先后错落；
    - 末尾自动按最长音符的结束点对齐，整体再做一次软限幅防止叠加削波。
    """
    rendered = []
    end_samples = 0
    for (freq, duration, start_delay, amp) in notes:
        wav = render_note(freq, duration, amp=amp)
        start = int(SAMPLE_RATE * start_delay)
        rendered.append((start, wav))
        end_samples = max(end_samples, start + len(wav))

    buf = [0.0] * end_samples
    for start, wav in rendered:
        for i, v in enumerate(wav):
            buf[start + i] += v

    # 软限幅：找峰值，若超过 0.99 则整体缩放，避免 16-bit 截断爆音。
    peak = max((abs(v) for v in buf), default=0.0)
    if peak > 0.99:
        scale = 0.99 / peak
        buf = [v * scale for v in buf]
    return buf


def write_wav(path, samples):
    """把浮点波形（-1~1）量化为 16-bit PCM 单声道写入 WAV 文件。"""
    frames = bytearray()
    for v in samples:
        # 钳制到 [-1,1] 后映射到 16-bit 有符号整数。
        c = max(-1.0, min(1.0, v))
        frames += struct.pack("<h", int(c * MAX_AMP))
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(SAMPLE_WIDTH)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(bytes(frames))


# 音名 -> 频率（十二平均律，A4=440Hz）便于按谱面书写。
def note_hz(name):
    """把音名（如 'A4'、'E5'、'C#6'）转换为频率 Hz。"""
    names = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5,
             "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}
    pitch = name[:-1]
    octave = int(name[-1])
    semitone = names[pitch] + (octave - 4) * 12 - 9  # 相对 A4 的半音数
    return 440.0 * (2.0 ** (semitone / 12.0))


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    # —— 五个语义时机的音色设计（Copilot 风：清亮、柔和、短促，不打扰）——

    # 1) 输入已发送：极轻单音「叮」，中高音、很短，作为「已收到」的轻反馈。
    input_sent = mix_sequence([
        (note_hz("A5"), 0.16, 0.0, 0.5),
    ])

    # 2) 权限请求：上行双音「叮-咚↑」（E5 -> A5），明亮、引起注意但不刺耳。
    permission = mix_sequence([
        (note_hz("E5"), 0.18, 0.0, 0.55),
        (note_hz("A5"), 0.24, 0.12, 0.55),
    ])

    # 3) 异常 / 中断：下行双音（A5 -> E5），温和的「停下来」收束感，区别于正常完成。
    interrupted = mix_sequence([
        (note_hz("A5"), 0.16, 0.0, 0.55),
        (note_hz("E5"), 0.26, 0.11, 0.5),
    ])

    # 4) 输出结束：愉悦的上行三音琶音（C5 -> E5 -> G5），表示「完成、可查看」。
    turn_complete = mix_sequence([
        (note_hz("C5"), 0.14, 0.0, 0.5),
        (note_hz("E5"), 0.14, 0.10, 0.5),
        (note_hz("G5"), 0.30, 0.20, 0.55),
    ])

    # 5) 通用通知：柔和同音双击「叮·叮」（D5），提示「请注意」。
    notification = mix_sequence([
        (note_hz("D5"), 0.14, 0.0, 0.5),
        (note_hz("D5"), 0.20, 0.16, 0.5),
    ])

    files = {
        "input-sent.wav": input_sent,
        "permission.wav": permission,
        "interrupted.wav": interrupted,
        "turn-complete.wav": turn_complete,
        "notification.wav": notification,
    }

    for name, samples in files.items():
        path = os.path.join(OUT_DIR, name)
        write_wav(path, samples)
        size = os.path.getsize(path)
        print(f"  生成 {name}  ({size} bytes, {len(samples)/SAMPLE_RATE:.2f}s)")

    print(f"完成，输出目录：{OUT_DIR}")


if __name__ == "__main__":
    main()
