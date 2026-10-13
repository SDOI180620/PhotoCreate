# PhotoCreate ComfyUI 環境套件

`manifest.json` 固定每個模型的來源版本、檔案大小及 SHA-256，下載時僅補足缺少的檔案。模型權重不放進此專案。

## 模型來源

- Qwen 2.1 Uncensored 主模型、Qwen3VL 編碼器與 VAE：[abenzerps/Qwen-Image-2.1-Uncensored-GGUF](https://huggingface.co/abenzerps/Qwen-Image-2.1-Uncensored-GGUF)。
- Qwen Image Edit 2511 主模型：[Comfy-Org/Qwen-Image-Edit_ComfyUI](https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI)。
- Qwen 2.5 VL 編碼器及 Qwen Image VAE：[Comfy-Org/Qwen-Image_ComfyUI](https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI)。
- Multiple Angles LoRA：[fal/Qwen-Image-Edit-2511-Multiple-Angles-LoRA](https://huggingface.co/fal/Qwen-Image-Edit-2511-Multiple-Angles-LoRA)。
- Qwen Image 2.1 Multiple-Angles v2 LoRA：[akhaliq/Qwen-Image-2.1-Multiple-Angles-LoRA](https://huggingface.co/akhaliq/Qwen-Image-2.1-Multiple-Angles-LoRA)，使用 v2 step 1500（318,819,792 bytes）。來源 commit 與 SHA-256 固定在 manifest。

使用時適用各來源模型的授權與存取條件，請依來源頁提供的版本與說明配置 ComfyUI。

## 相機節點

來源：[jtydhr88/ComfyUI-qwenmultiangle](https://github.com/jtydhr88/ComfyUI-qwenmultiangle)，版本 0.7.0。此套件保存 PhotoCreate 目前使用的加強版 Python 與 3D 前端：俯仰支援 −90° / −60°，Zoom 支援 9 / 10，包含對應的額外距離與角度指令。

原作者為 Terry Jia，MIT 授權保存在 `custom_nodes/ComfyUI-qwenmultiangle/LICENSE`。前端為既有節點的編譯檔，沿用其中的 Vue、Three.js 等內容。節點使用 ComfyUI 的 numpy、Pillow、typing_extensions 與 comfy_api；沒有另行自動執行 pip、git 或主機重啟。

## 工作流

套件包含角色與服裝、2511 相機、2.1 相機三份 UI 工作流，已清除圖片名稱、實際提詞及相機圖片預覽。安裝時放到 `user/default/workflows/PhotoCreate/`，由執行中的 ComfyUI schema 轉換為 API 格式，依序檢查原圖、換角度及高清修正。後台「視角拍攝版本」選擇 2511 或 2.1，通過檢查後才套用；新增拍攝保存相機工作流，既有任務及重製沿用自己的快照。

2.1 相機工作流沿用目前的 Qwen Image 2.1 INT8 ConvRot 主模型、Qwen3-VL 編碼器與 2.1 VAE，加載 2.1 專用 v2 LoRA，使用 `<mva>` 格式；2511 維持原來的 `<sks>` 格式。安裝只下載所選版本所需的模型，2.1 不需要另外下載 2511 模型。兩個版本的相機成果均可接續獨立的 Qwen 2.1 低強度修復。

目前的水平角度、−90° 歷史仰拍到 60° 俯拍及 Zoom 五級取景都保留。2.1 原生水平標籤以 30° 分組，精確角度另寫入提示詞；負角度仰拍與遠景／全身／局部特寫採用補充指令，未改動 LoRA 權重或增加訓練姿態。ComfyUI 獨立操作時將相機節點 `model_version` 設為與 LoRA 相同的版本。節點升級後需重啟 ComfyUI。

程式只安裝這套工作流與其依賴，不安裝 Python、CUDA 或 ComfyUI 主程式。缺少 Qwen 2.1 核心節點時，需先安裝支援它們的 ComfyUI 版本。可參照 [ComfyUI Qwen 核心節點](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_qwen.py)。

## H3 圖生影片環境

模型選擇位於「工作室設定 → 環境與工作流 → 進階設定」。換到另一台電腦時，選擇該電腦的 ComfyUI 目錄，按底部固定的「安裝環境」，會依所選的拍攝與影片版本，一次檢查並補齊節點、工作流與缺少的模型。模型已齊全時略過，支援暫停、重開續傳，完整 SHA-256 驗證通過後才放入正式位置。修改過的有效工作流會保留參數，完成後自動檢查並載入；需要重啟 ComfyUI 時會顯示提示，重啟後再按同一個安裝按鈕。

`video-manifest.json` 固定 [FastVideo/FastVideo-FastH3-Trim-Comfy](https://huggingface.co/FastVideo/FastVideo-FastH3-Trim-Comfy)、[Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3) 與 [H3 Latent Upscaler](https://huggingface.co/LBH-123-AI/Minimax_h3_latent_Upscaler) 的來源版本、檔案大小與 SHA-256。一採下載所選的四個模型；二採額外包含 Latent 升頻模型與固定版本的升頻節點。可改選 FP16 影片 VAE 或 INT8 ConvRot 文字編碼器。自行安裝的相容模型也能保存選用，沒有已知來源的缺少模型需手動安裝或改選可下載版本。

影片工作流使用 [FastH3 Trim 原始流程](https://github.com/amao2001/ganloss-latent-space/tree/main/workflow/2026-10-12%20fastH3%20trim)，保留 BasicGuider、Sigma Shift 12／3、VSA 10% 與影片／音訊解碼，加入精確 5／7／10 秒裁切與 ComfyUI 原生 MP4 儲存。一採預設 KSamplerSelect euler、BasicScheduler simple／8 步、Resolution Selector (Size) 1 Megapixels／multiple 32。二採預設 NVFP4，前段取 8 步排程的前 4 步，分離音訊與影片 latent、升頻影片 latent、重新合併，再依 `0.9035, 0.6316, 0.3158, 0.0000` 細化 3 步，解析度 0.4 MP → 1 MP。升頻節點按目前官方動態輸入 schema 轉換，保留 target dimensions、align 32、fp16 與 temporal chunking。

安裝的「01 FastH3 Trim - 圖生影片.json」是可在 ComfyUI 開啟的 nodes／links 格式。PhotoCreate 每次產新影片都會讀取這台 ComfyUI 已儲存的工作流並轉成 API；採樣器、排程器、Megapixels 與其他工作流參數保留，照片、提詞、秒數、比例、後台所選模型與輸出路徑依本次產片設定填入。已排入的影片保存工作流快照，後續編輯不會改動它們。另存新工作流時，可在 H3 區塊選擇並套用。內附 API 與可編輯工作流逐節點比對；動態選項包含 VSA keep_percent 與 MP4 codec。舊版安裝的未修改 API 檔會移到可恢復備份。

按「檢查 H3 環境」會確認執行中 ComfyUI 的節點與模型；缺核心 H3 節點時需更新並重新啟動 ComfyUI，下載模型不會更新 ComfyUI 主程式。官方影片提詞使用共同提詞資料庫與編輯對話框，首頁勾選後按「套用至顧客攝影棚」發布；草稿及未勾選項目不會開放給顧客。編輯器可選後台照片或上傳臨時圖片試跑，顧客自行輸入的影片提詞可收藏在自己的帳號。

圖片與每段已完成影片可各自加入精選，同一來源可同時保留圖片與多段影片。照片卡片顯示已完成影片圖示與數量，產影片選項顯示目前照片版本的數量。刪除單段影片只移除該影片的精選；永久刪除來源照片仍一併清理相關影片。
