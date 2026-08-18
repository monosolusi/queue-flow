# syntax=docker/dockerfile:1

# tts-service — Indonesian announcement synthesis for the TV queue board.
# Route: /tts/*  (proxied by the `gateway`)
#
# NFR-REL-01 (no internet at runtime): the Piper voice is downloaded during BUILD
# and baked into the image, so nothing is fetched while the store is open. Needing
# the network at build time is already true of every service here — they all run
# `npm ci` — so this adds no new operational requirement.
# NFR-MNT-02 (one-command bring-up): because the model ships inside the image,
# `docker compose up -d --build` is the only step; no operator has to stage a
# 63 MB file first.
# NFR-REL-03 (self-healing): restart policy lives in docker-compose.yml.
#
# Base image note: this MUST be Debian (slim), not Alpine. onnxruntime — pulled in
# by piper-tts — publishes manylinux wheels only, with no musllinux build, so on
# Alpine pip would fall back to compiling ONNX Runtime from source and fail.

FROM python:3.13-slim AS build

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Dependencies before source, mirroring how the Node services copy package.json
# ahead of their sources: editing app code must not reinstall onnxruntime.
COPY requirements.txt ./
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --requirement requirements.txt

# The voice lands on its own layer, after the dependency install and before any
# source is copied. Source edits therefore never re-download 63 MB; only a
# requirements.txt change does.
ARG QMS_TTS_VOICE=id_ID-news_tts-medium
RUN /opt/venv/bin/python -m piper.download_voices "${QMS_TTS_VOICE}" \
        --data-dir /opt/models \
    && ls -l /opt/models


FROM python:3.13-slim AS runtime

# ffmpeg does the loudness normalisation, silence trim, bell synthesis and MP3
# encode. It is a hard runtime dependency, not a build tool.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    QMS_TTS_MODELS_DIR=/opt/models \
    QMS_TTS_RECORDINGS_DIR=/app/recordings \
    QMS_TTS_CACHE_DIR=/var/cache/qms-tts

WORKDIR /app

COPY --from=build /opt/venv /opt/venv
COPY --from=build /opt/models /opt/models
COPY app ./app

EXPOSE 8000

# No HEALTHCHECK here: every service in this repo declares its probe in
# docker-compose.yml instead, and the compose probe is what `depends_on` reads.
# (For the record, the core-api `wget -qO-` idiom does NOT port to this image —
# python:*-slim ships neither wget nor curl — so the compose probe uses python.)
CMD ["uvicorn", "app.main:api", "--host", "0.0.0.0", "--port", "8000"]
