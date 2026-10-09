export const CAMERA_TEMPLATE = {
  "1": {
    "class_type": "UNETLoader",
    "inputs": {
      "unet_name": "qwen_image_edit_2511_fp8mixed.safetensors",
      "weight_dtype": "default"
    },
    "_meta": {
      "title": "Qwen 2511 主模型"
    }
  },
  "2": {
    "class_type": "CLIPLoader",
    "inputs": {
      "clip_name": "qwen_2.5_vl_7b_fp8_scaled.safetensors",
      "type": "qwen_image",
      "device": "default"
    },
    "_meta": {
      "title": "Qwen 文字編碼器"
    }
  },
  "3": {
    "class_type": "VAELoader",
    "inputs": {
      "vae_name": "qwen_image_vae.safetensors"
    },
    "_meta": {
      "title": "Qwen VAE"
    }
  },
  "4": {
    "class_type": "LoraLoaderModelOnly",
    "inputs": {
      "model": [
        "1",
        0
      ],
      "lora_name": "qwen-image-edit-2511-multiple-angles-lora.safetensors",
      "strength_model": 0.9
    },
    "_meta": {
      "title": "Multiple-Angles LoRA｜強度 0.9"
    }
  },
  "5": {
    "class_type": "ModelSamplingAuraFlow",
    "inputs": {
      "model": [
        "4",
        0
      ],
      "shift": 3.1,
      "sampling": "flow"
    },
    "_meta": {
      "title": "Qwen 採樣設定"
    }
  },
  "6": {
    "class_type": "CFGNorm",
    "inputs": {
      "model": [
        "5",
        0
      ],
      "strength": 1,
      "pre_cfg": false
    },
    "_meta": {
      "title": "CFG 正規化"
    }
  },
  "7": {
    "class_type": "LoadImage",
    "inputs": {
      "image": "Qwen_Multiangle_install_test.png"
    },
    "_meta": {
      "title": "步驟 1｜上傳一張照片"
    }
  },
  "8": {
    "class_type": "FluxKontextImageScale",
    "inputs": {
      "image": [
        "7",
        0
      ]
    },
    "_meta": {
      "title": "參考圖尺寸"
    }
  },
  "9": {
    "class_type": "QwenMultiangleCameraNode",
    "inputs": {
      "image": [
        "7",
        0
      ],
      "horizontal_angle": 45,
      "vertical_angle": 0,
      "zoom": 5,
      "default_prompts": true,
      "camera_view": false
    },
    "_meta": {
      "title": "步驟 2｜拖曳 3D 相機選角度"
    }
  },
  "10": {
    "class_type": "TextEncodeQwenImageEditPlus",
    "inputs": {
      "clip": [
        "2",
        0
      ],
      "vae": [
        "3",
        0
      ],
      "image1": [
        "8",
        0
      ],
      "prompt": [
        "9",
        0
      ]
    },
    "_meta": {
      "title": "相機角度提示詞（自動連入）"
    }
  },
  "11": {
    "class_type": "TextEncodeQwenImageEditPlus",
    "inputs": {
      "clip": [
        "2",
        0
      ],
      "vae": [
        "3",
        0
      ],
      "image1": [
        "8",
        0
      ],
      "prompt": ""
    },
    "_meta": {
      "title": "負面提示詞（留空）"
    }
  },
  "12": {
    "class_type": "VAEEncode",
    "inputs": {
      "pixels": [
        "8",
        0
      ],
      "vae": [
        "3",
        0
      ]
    },
    "_meta": {
      "title": "建立採樣尺寸"
    }
  },
  "13": {
    "class_type": "KSampler",
    "inputs": {
      "model": [
        "6",
        0
      ],
      "positive": [
        "10",
        0
      ],
      "negative": [
        "11",
        0
      ],
      "latent_image": [
        "12",
        0
      ],
      "seed": 251190,
      "steps": 20,
      "cfg": 4,
      "sampler_name": "euler",
      "scheduler": "simple",
      "denoise": 1
    },
    "_meta": {
      "title": "步驟 3｜按 Run 生成"
    }
  },
  "14": {
    "class_type": "VAEDecode",
    "inputs": {
      "samples": [
        "13",
        0
      ],
      "vae": [
        "3",
        0
      ]
    },
    "_meta": {
      "title": "VAE 解碼"
    }
  },
  "15": {
    "class_type": "SaveImage",
    "inputs": {
      "images": [
        "14",
        0
      ],
      "filename_prefix": "Qwen_Multiangle/Camera_View"
    },
    "_meta": {
      "title": "新視角圖片｜儲存到 output/Qwen_Multiangle"
    }
  }
};
