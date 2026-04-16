"""larp-pipeline CLI."""
from __future__ import annotations

import typer
from rich.console import Console

from larp_pipeline.paths import ensure_dirs, video_ids

app = typer.Typer(add_completion=False, help="LARP pipeline: raw videos -> meeting personas.")
console = Console()


@app.command()
def status() -> None:
    """Show counts for each pipeline stage."""
    from larp_pipeline.paths import (
        RAW, TRANSCRIPTS, KEYFRAMES, CHARACTERS, PERSONAS, GRUNTS,
    )
    ensure_dirs()
    ids = video_ids()
    console.print(f"[bold]videos ingested:[/bold] {len(ids)}  (in {RAW})")
    console.print(f"  transcripts: {len(list(TRANSCRIPTS.glob('*.json')))}")
    console.print(f"  keyframes:   {sum(1 for _ in KEYFRAMES.glob('*/frame_*.jpg'))}")
    chars_file = CHARACTERS / "characters.json"
    console.print(f"  characters:  {'yes' if chars_file.exists() else 'no'} ({chars_file})")
    console.print(f"  personas:    {len(list(PERSONAS.glob('*.json')))}")
    console.print(f"  grunts:      {sum(1 for _ in GRUNTS.glob('*/*.mp3'))}")


@app.command()
def transcribe(force: bool = False) -> None:
    """Run faster-whisper on all ingested videos."""
    from larp_pipeline.transcribe import transcribe_all
    transcribe_all(force=force)


@app.command()
def keyframes(per_video: int = 6) -> None:
    """Extract keyframes per video via ffmpeg."""
    from larp_pipeline.keyframes import extract_all
    extract_all(per_video=per_video)


@app.command()
def characters() -> None:
    """Cluster + label characters from keyframes using Claude vision."""
    from larp_pipeline.characters import run
    run()


@app.command()
def personas() -> None:
    """Generate persona system prompts from transcripts + character labels."""
    from larp_pipeline.personas import run
    run()


@app.command()
def grunts() -> None:
    """Extract per-character non-verbal audio ad-libs."""
    from larp_pipeline.grunts import run
    run()


@app.command("all")
def run_all() -> None:
    """Run every stage in order."""
    transcribe()
    keyframes()
    characters()
    personas()
    grunts()


if __name__ == "__main__":
    app()
