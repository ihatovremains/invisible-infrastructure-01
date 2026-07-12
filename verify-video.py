#!/usr/bin/env python3
"""Verify the deterministic PNG sequence and encoded social video."""

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image


FPS = 30
FRAME_COUNT = 1572
WIDTH = 1080
HEIGHT = 1350


def parse_args():
    project = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser()
    parser.add_argument("--master", type=Path, default=project / "ep01-social-1080x1350-master.mp4")
    parser.add_argument("--diagnostic", type=Path, default=project / "ep01-seam-25.5-26.5-4x.mp4")
    parser.add_argument("--render-dir", type=Path, default=project / "render")
    parser.add_argument("--ffprobe", default=shutil.which("ffprobe") or "ffprobe")
    return parser.parse_args()


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def ffprobe(path, executable):
    command = [
        executable,
        "-v", "error",
        "-count_frames",
        "-show_entries",
        "format=duration,size,bit_rate,format_name:"
        "stream=index,codec_name,codec_type,profile,width,height,pix_fmt,"
        "r_frame_rate,avg_frame_rate,nb_frames,nb_read_frames,"
        "color_range,color_space,color_transfer,color_primaries",
        "-of", "json",
        str(path),
    ]
    return json.loads(subprocess.check_output(command, text=True))


def add_check(checks, name, passed, details):
    checks[name] = {"passed": bool(passed), "details": details}


def load_telemetry(path):
    with path.open() as handle:
        return [json.loads(line) for line in handle if line.strip()]


def decode_metrics(master):
    capture = cv2.VideoCapture(str(master))
    if not capture.isOpened():
        raise RuntimeError(f"Could not open {master}")

    opening_luma = []
    seam_shifts = []
    seam_responses = []
    closing_diffs = []
    previous_seam = None
    previous_closing = None
    decoded = 0

    seam_first = round(25.5 * FPS)
    seam_last = round(26.5 * FPS)
    closing_first = FRAME_COUNT - 75

    while True:
        ok, frame = capture.read()
        if not ok:
            break
        index = decoded
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

        if index <= 4:
            opening_luma.append(float(gray[220:980, 90:990].mean()))

        if seam_first <= index <= seam_last:
            roi = gray[100:1150, 400:1080].astype(np.float32)
            if previous_seam is not None:
                shift, response = cv2.phaseCorrelate(previous_seam, roi)
                seam_shifts.append({
                    "fromFrame": index - 1,
                    "toFrame": index,
                    "dx": float(shift[0]),
                    "dy": float(shift[1]),
                    "response": float(response),
                })
                seam_responses.append(float(response))
            previous_seam = roi

        if index >= closing_first:
            if previous_closing is not None:
                diff = cv2.absdiff(previous_closing, gray)
                closing_diffs.append(float(diff.mean()))
            previous_closing = gray

        decoded += 1

    capture.release()
    return {
        "decodedFrames": decoded,
        "openingLuma": opening_luma,
        "openingLumaRange": max(opening_luma) - min(opening_luma) if opening_luma else None,
        "seamShifts": seam_shifts,
        "maxPositiveSeamDx": max((row["dx"] for row in seam_shifts), default=None),
        "minSeamDx": min((row["dx"] for row in seam_shifts), default=None),
        "minSeamResponse": min(seam_responses) if seam_responses else None,
        "closingAdjacentMeanDiffs": closing_diffs,
        "maxClosingAdjacentMeanDiff": max(closing_diffs) if closing_diffs else None,
    }


def main():
    args = parse_args()
    render_dir = args.render_dir.resolve()
    frames_dir = render_dir / "frames"
    telemetry_path = render_dir / "capture-telemetry.jsonl"
    output_path = render_dir / "verification.json"
    checks = {}
    metrics = {}

    required = [args.master, args.diagnostic, frames_dir, telemetry_path]
    missing = [str(path) for path in required if not path.exists()]
    if missing:
        raise FileNotFoundError("Missing required artifacts:\n" + "\n".join(missing))

    probe = ffprobe(args.master, args.ffprobe)
    streams = probe.get("streams", [])
    video_streams = [stream for stream in streams if stream.get("codec_type") == "video"]
    audio_streams = [stream for stream in streams if stream.get("codec_type") == "audio"]
    video = video_streams[0] if video_streams else {}
    duration = float(probe["format"]["duration"])
    frame_count = int(video.get("nb_read_frames") or video.get("nb_frames") or 0)

    add_check(checks, "single_video_stream_no_audio",
              len(video_streams) == 1 and not audio_streams,
              {"videoStreams": len(video_streams), "audioStreams": len(audio_streams)})
    add_check(checks, "master_geometry",
              video.get("width") == WIDTH and video.get("height") == HEIGHT,
              {"width": video.get("width"), "height": video.get("height")})
    add_check(checks, "master_codec",
              video.get("codec_name") == "h264" and video.get("profile") == "High" and video.get("pix_fmt") == "yuv420p",
              {"codec": video.get("codec_name"), "profile": video.get("profile"), "pixelFormat": video.get("pix_fmt")})
    add_check(checks, "constant_30_fps",
              video.get("r_frame_rate") == "30/1" and video.get("avg_frame_rate") == "30/1",
              {"rFrameRate": video.get("r_frame_rate"), "avgFrameRate": video.get("avg_frame_rate")})
    add_check(checks, "duration_and_frame_count",
              abs(duration - 52.4) < 0.001 and frame_count == FRAME_COUNT,
              {"duration": duration, "frames": frame_count})
    add_check(checks, "bt709_metadata",
              video.get("color_space") == "bt709"
              and video.get("color_transfer") == "bt709"
              and video.get("color_primaries") == "bt709",
              {"matrix": video.get("color_space"), "transfer": video.get("color_transfer"), "primaries": video.get("color_primaries")})

    master_prefix = args.master.read_bytes()[:1024 * 1024]
    moov_offset = master_prefix.find(b"moov")
    mdat_offset = master_prefix.find(b"mdat")
    add_check(checks, "faststart", moov_offset >= 0 and mdat_offset >= 0 and moov_offset < mdat_offset,
              {"moovOffset": moov_offset, "mdatOffset": mdat_offset})

    pngs = sorted(frames_dir.glob("frame_*.png"))
    add_check(checks, "png_frame_count", len(pngs) == FRAME_COUNT, {"frames": len(pngs)})
    if pngs:
        with Image.open(pngs[0]) as image:
            first_size = image.size
        add_check(checks, "png_geometry", first_size == (2160, 2700), {"size": first_size})

    opening_hashes = [file_sha256(path) for path in pngs[:5]]
    add_check(checks, "raw_opening_clean", len(opening_hashes) == 5 and len(set(opening_hashes)) == 1,
              {"uniqueHashes": len(set(opening_hashes))})
    raw_closing_diffs = []
    previous = None
    for frame_path in pngs[-75:]:
        current = np.asarray(Image.open(frame_path).convert("RGB"), dtype=np.int16)
        if previous is not None:
            raw_closing_diffs.append(float(np.abs(current - previous).mean()))
        previous = current
    max_raw_closing_diff = max(raw_closing_diffs, default=None)
    add_check(checks, "raw_closing_hold_2_5s",
              len(raw_closing_diffs) == 74 and max_raw_closing_diff is not None and max_raw_closing_diff < 0.001,
              {"maxAdjacentMeanDifference": max_raw_closing_diff, "frames": min(len(pngs), 75)})

    telemetry = load_telemetry(telemetry_path)
    seam_rows = [row for row in telemetry if 25.55 <= row["timeSeconds"] <= 26.8]
    world_deltas = [seam_rows[i]["worldX"] - seam_rows[i - 1]["worldX"] for i in range(1, len(seam_rows))]
    max_positive_world = max(world_deltas, default=None)
    total_world_motion = seam_rows[-1]["worldX"] - seam_rows[0]["worldX"] if len(seam_rows) > 1 else None
    metrics["captureWorld"] = {
        "maxPositiveDelta": max_positive_world,
        "totalMotion": total_world_motion,
        "samples": len(seam_rows),
    }
    add_check(checks, "capture_world_monotone",
              max_positive_world is not None and max_positive_world <= 0.25 and total_world_motion is not None and total_world_motion < -1000,
              metrics["captureWorld"])

    ui_leaks = [row["frame"] for row in telemetry
                if row["controlsDisplay"] != "none" or row["hintsDisplay"] != "none" or row["cursor"] != "none"]
    add_check(checks, "no_ui_or_cursor", not ui_leaks, {"leakFrames": ui_leaks[:20]})

    final = telemetry[-1]
    add_check(checks, "credit_exact_and_visible",
              final["creditText"] == "Concept, design and code by Takaaki Suzuki"
              and final["creditOpacity"] >= 0.999 and final["creditInViewport"],
              {"text": final["creditText"], "opacity": final["creditOpacity"], "inViewport": final["creditInViewport"]})
    add_check(checks, "closing_complete",
              final["closingAllIn"] and final["closingMinOpacity"] >= 0.999 and final["closingCtaOpacity"] >= 0.999,
              {"allIn": final["closingAllIn"], "minOpacity": final["closingMinOpacity"], "ctaOpacity": final["closingCtaOpacity"]})

    decoded = decode_metrics(args.master)
    metrics["decodedVideo"] = decoded
    add_check(checks, "decoded_frame_count", decoded["decodedFrames"] == FRAME_COUNT,
              {"frames": decoded["decodedFrames"]})
    add_check(checks, "encoded_opening_clean",
              decoded["openingLumaRange"] is not None and decoded["openingLumaRange"] < 0.05,
              {"luma": decoded["openingLuma"], "range": decoded["openingLumaRange"]})
    add_check(checks, "encoded_seam_no_reverse_jump",
              decoded["maxPositiveSeamDx"] is not None and decoded["maxPositiveSeamDx"] <= 1.0,
              {"maxPositiveDx": decoded["maxPositiveSeamDx"], "minDx": decoded["minSeamDx"], "minResponse": decoded["minSeamResponse"]})
    add_check(checks, "encoded_closing_static",
              decoded["maxClosingAdjacentMeanDiff"] is not None and decoded["maxClosingAdjacentMeanDiff"] < 0.05,
              {"maxAdjacentMeanDifference": decoded["maxClosingAdjacentMeanDiff"]})

    diagnostic_probe = ffprobe(args.diagnostic, args.ffprobe)
    diagnostic_video = next((stream for stream in diagnostic_probe.get("streams", []) if stream.get("codec_type") == "video"), {})
    diagnostic_duration = float(diagnostic_probe["format"]["duration"])
    diagnostic_frames = int(diagnostic_video.get("nb_read_frames") or diagnostic_video.get("nb_frames") or 0)
    add_check(checks, "diagnostic_4x_clip",
              3.9 <= diagnostic_duration <= 4.1 and 118 <= diagnostic_frames <= 122
              and diagnostic_video.get("r_frame_rate") == "30/1",
              {"duration": diagnostic_duration, "frames": diagnostic_frames, "fps": diagnostic_video.get("r_frame_rate")})

    report = {
        "passed": all(item["passed"] for item in checks.values()),
        "master": str(args.master.resolve()),
        "masterSha256": file_sha256(args.master),
        "diagnostic": str(args.diagnostic.resolve()),
        "diagnosticSha256": file_sha256(args.diagnostic),
        "checks": checks,
        "metrics": metrics,
        "ffprobe": probe,
    }
    output_path.write_text(json.dumps(report, indent=2) + "\n")

    for name, item in checks.items():
        status = "PASS" if item["passed"] else "FAIL"
        print(f"{status:4}  {name}")
    print(f"\nVerification report: {output_path}")

    if not report["passed"]:
        failed = [name for name, item in checks.items() if not item["passed"]]
        print("Failed checks: " + ", ".join(failed), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
