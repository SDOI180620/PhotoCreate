# PhotoCreate ComfyUI 環境套件

`manifest.json` 固定每個模型的來源版本、檔案大小及 SHA-256，下載時僅補足缺少的檔案。模型權重不放進此專案。

## 模型來源

- Qwen 2.1 Uncensored 主模型、Qwen3VL 編碼器與 VAE：[abenzerps/Qwen-Image-2.1-Uncensored-GGUF](https://huggingface.co/abenzerps/Qwen-Image-2.1-Uncensored-GGUF)。
- Qwen Image Edit 2511 主模型：[Comfy-Org/Qwen-Image-Edit_ComfyUI](https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI)。
- Qwen 2.5 VL 編碼器及 Qwen Image VAE：[Comfy-Org/Qwen-Image_ComfyUI](https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI)。
- Multiple Angles LoRA：[fal/Qwen-Image-Edit-2511-Multiple-Angles-LoRA](https://huggingface.co/fal/Qwen-Image-Edit-2511-Multiple-Angles-LoRA)。

使用時適用各來源模型的授權與存取條件，請依來源頁提供的版本與說明配置 ComfyUI。

## 相機節點

來源：[jtydhr88/ComfyUI-qwenmultiangle](https://github.com/jtydhr88/ComfyUI-qwenmultiangle)，版本 0.7.0。此套件保存 PhotoCreate 目前使用的加強版 Python 與 3D 前端：俯仰支援 −90° / −60°，Zoom 支援 9 / 10，包含對應的額外距離與角度指令。

原作者為 Terry Jia，MIT 授權保存在 `custom_nodes/ComfyUI-qwenmultiangle/LICENSE`。前端為既有節點的編譯檔，沿用其中的 Vue、Three.js 等內容。節點使用 ComfyUI 的 numpy、Pillow、typing_extensions 與 comfy_api；沒有另行自動執行 pip、git 或主機重啟。

## 工作流

工作流為此專案目前使用的兩份 UI 工作流，已清除圖片名稱、實際提詞及相機圖片預覽。安裝時放到 `user/default/workflows/PhotoCreate/`，由執行中的 ComfyUI schema 轉換為 API 格式，依序檢查原圖、換角度及高清修正。

程式只安裝這套工作流與其依賴，不安裝 Python、CUDA 或 ComfyUI 主程式。缺少 Qwen 2.1 核心節點時，需先安裝支援它們的 ComfyUI 版本。可參照 [ComfyUI Qwen 核心節點](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_qwen.py)。
