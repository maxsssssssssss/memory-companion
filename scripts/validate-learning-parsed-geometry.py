"""Offline source-location evidence. No OCR, text extraction, network or quality reclassification."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

from PIL import Image, ImageChops, ImageDraw, ImageStat

parser = argparse.ArgumentParser()
parser.add_argument("--handoff", required=True)
parser.add_argument("--sources", required=True, help="Repository read-back source receipts")
parser.add_argument("--output", required=True)
args = parser.parse_args()
root = Path(args.handoff).resolve()
output = Path(args.output).resolve()
if not output.is_relative_to(Path.cwd().resolve() / "output"):
    raise ValueError("Evidence output must stay in this workspace's output directory")
output.mkdir(parents=True, exist_ok=True)


def local(relative):
    result = (root / relative).resolve()
    if not result.is_relative_to(root):
        raise ValueError("Handoff path escaped root")
    return result


manifest = json.loads(local("handoff-manifest.json").read_text("utf-8"))
sources = json.loads(Path(args.sources).read_text("utf-8"))
assert len(sources) == 18
poppler = shutil.which("pdftoppm")
if not poppler:
    raise RuntimeError("pdftoppm unavailable; geometry rendering NOT RUN")


def render(pdf, page, destination):
    # Exact same renderer/settings for original, one-page input and excerpt.
    result = subprocess.run([poppler, "-f", str(page), "-l", str(page), "-singlefile", "-cropbox",
                             "-r", "144", "-png", str(pdf), str(destination)],
                            capture_output=True, timeout=45,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    (destination.with_suffix(".log")).write_bytes(result.stderr)
    if result.returncode != 0:
        raise RuntimeError(f"PDF rendering failed: {destination.name}")
    return Image.open(destination.with_suffix(".png")).convert("RGB")


results = []
for source in sources:
    case = source["case_ref"]
    mapping = next(p for p in manifest["pages"] if p["case_id"] == case)
    assert source["physical_page"] == mapping["source_physical_page_1based"]
    original = local(mapping["original_pdf"])
    assert hashlib.sha256(original.read_bytes()).hexdigest() == mapping["original_sha256"]
    assert source["size"]["rotation"] == 0 and source["size"]["userUnit"] == 1
    images = [render(original, source["physical_page"], output / f"{case}-original"),
              render(local(mapping["test_single_page_pdf"]), mapping["test_single_page_index_0based"] + 1, output / f"{case}-input"),
              render(local(mapping["selected_pages_pdf"]), mapping["selected_pdf_page_1based"], output / f"{case}-excerpt")]
    assert images[0].size == tuple(mapping["render_size_pixels"])
    assert all(im.size == images[0].size for im in images)
    comparisons = []
    for kind, other in zip(["single_page_input", "selected_excerpt"], images[1:]):
        diff = ImageChops.difference(images[0], other)
        comparisons.append({"against": kind, "pixel_identical": diff.getbbox() is None,
                            "mean_absolute_channel_difference": ImageStat.Stat(diff).mean})
    annotated = images[0].copy()
    draw = ImageDraw.Draw(annotated)
    region_count = 0
    for block in source["blocks"]:
        for region in block["source_regions"]:
            assert region["physical_page"] == source["physical_page"]
            width, height = annotated.size
            # Use REPOSITORY READ-BACK normalized boxes, not the server's overlay.
            coordinates = [v * (width if i % 2 == 0 else height) for i, v in enumerate(region["normalized_bbox"])]
            assert all(abs(a - b) < 1e-9 for a, b in zip(coordinates, region["bbox"]))
            draw.rectangle(coordinates, outline=(0, 140, 80), width=2)
            draw.text((coordinates[0] + 2, coordinates[1] + 2), region["parser_ref"]["block_id"], fill=(180, 0, 30))
            region_count += 1
    annotated.save(output / f"{case}-readback-regions.png")
    delivered = Image.open(local(mapping["original_render"])).convert("RGB")
    assert delivered.size == images[0].size
    # Side-by-side evidence: re-rendered original + persisted boxes / delivered render + existing overlay.
    existing_overlay = Image.open(local(mapping["parsing_overlay"])).convert("RGB")
    panels = [annotated, delivered, existing_overlay]
    sheet = Image.new("RGB", (1500, 780), "white")
    labels = [f"{case}: original PDF + read-back regions", "Delivered original render", "Delivered parser overlay"]
    for index, (im, label) in enumerate(zip(panels, labels)):
        im.thumbnail((490, 740))
        sheet.paste(im, (index * 500, 30))
        ImageDraw.Draw(sheet).text((index * 500 + 5, 5), label, fill="black")
    sheet.save(output / f"{case}-comparison.png")
    results.append({"case": case, "physical_page": source["physical_page"], "printed_label": mapping["source_printed_label"],
                    "parser_page_index": mapping["test_single_page_index_0based"], "excerpt_page": mapping["selected_pdf_page_1based"],
                    "render_size": list(images[0].size), "region_count": region_count, "comparisons": comparisons})
    print(f"[geometry] {len(results)}/18 {case}: {region_count} persisted regions; exact pixel matches {sum(c['pixel_identical'] for c in comparisons)}/2", flush=True)

summary = {"pages": len(results), "regions": sum(p["region_count"] for p in results), "results": results,
           "semantic_review": "NOT RUN", "actual_merged_regions": "NOT COVERED", "rotation_or_nonzero_crop": "NOT COVERED"}
(output / "geometry-results.json").write_text(json.dumps(summary, indent=2), "utf-8")
assert all(c["pixel_identical"] for p in results for c in p["comparisons"]), "Non-identical source mapping needs inspection"
