# Qwen Multiangle Camera — PhotoCreate bundled edition

Upstream: https://github.com/jtydhr88/ComfyUI-qwenmultiangle (0.7.0).

Copyright (c) 2026 Terry Jia. MIT license; see LICENSE.

This edition preserves PhotoCreate's existing enhanced Python implementation
and bundled 3D frontend. Elevation extends to -90 degrees, including the -60
degree preset; distance includes experimental extreme close-up (9) and macro
close-up (10), with corresponding additional prompt instructions.

The optional model_version input selects the existing 2511 <sks> grammar
or the Qwen Image 2.1 <mva> grammar for its Multiple-Angles v2 LoRA.
2.1 keeps the five PhotoCreate framing levels and exact requested coordinates.
Negative elevations use supplemental instructions rather than newly trained
LoRA poses. The widget preview and Python execution use the same pose labels.

Copy this folder into ComfyUI/custom_nodes and restart ComfyUI to load it.
Requires the dependencies provided by ComfyUI (numpy, Pillow,
typing_extensions and comfy_api). No additional pip command is needed.

See ../../README.md in the PhotoCreate bundle for workflow and model sources.
