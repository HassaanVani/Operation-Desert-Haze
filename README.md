# Operation-Desert-Haze

## Project description

Music-timed interactive web experience driven by a precomputed beat map.

## Architecture

The Next.js page renders the experience; `beat_map.json` supplies timing data; `analyze_audio.py` generates/inspects beat metadata; media is served from `public/`.

## Technology

Next.js • TypeScript • Python audio analysis

## Run locally

`npm install && npm run dev`

## Repository guide

The implementation is organized so that entry points remain thin and domain-specific logic stays in the modules named above. Configuration, assets, and deployment files are kept separate from application code. Review the source tree before changing behavior, and keep secrets in local environment files rather than committing them.
