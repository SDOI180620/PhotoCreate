# Qwen Multiangle Camera — PhotoCreate bundled edition

Upstream: https://github.com/jtydhr88/ComfyUI-qwenmultiangle (0.7.0).

Copyright (c) 2026 Terry Jia. MIT license; see LICENSE.

This edition preserves PhotoCreate's existing enhanced Python implementation
and bundled 3D frontend. Elevation extends to -90 degrees, including the -60
degree preset; distance includes experimental extreme close-up (9) and macro
close-up (10), with corresponding additional prompt instructions.

Copy this folder into ComfyUI/custom_nodes and restart ComfyUI to load it.
Requires the dependencies provided by ComfyUI (numpy, Pillow,
typing_extensions and comfy_api). No additional pip command is needed.

See ../../README.md in the PhotoCreate bundle for workflow and model sources.
