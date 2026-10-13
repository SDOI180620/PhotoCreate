# Qwen-Image-2.1 提詞與編輯限制查證

查證日期：2026-10-12（Asia/Taipei）。範圍以可本機部署的 `Qwen/Qwen-Image-2.1` 與官方推薦的 Diffusers／ComfyUI 實作為主。本筆記是官方資料查證；未用生成實驗證明本專案的姿勢失敗原因。

## 動作需要雙引號嗎？

不需要。官方編輯提詞改寫器把雙引號用於「要顯示在圖片中的可讀文字」，並要求一般描述不要加引號。動作直接寫成自然語句；引號不是動作加權符號。JSON 的字串引號只是資料格式，和傳入模型的文字內容不同。[官方 I2I system prompt](https://huggingface.co/Qwen/Qwen-Image-2.1-PE-I2I/blob/main/system_prompt.txt)

官方 T2I 改寫器對單一人物會先交代背景、姿勢與在畫面的位置，再描述臉、身體、衣著及接觸物。它使用完整段落，建議約 20 句、400–500 個英文單字；這是改寫器的輸出風格，不是模型最短／最長提詞限制。[官方 T2I system prompt](https://github.com/QwenLM/Qwen-Image-2.1/blob/main/prompt_rewrite/prompts/system_prompt_t2i.txt)

ComfyUI 的 2.1 tokenizer 繼承 Qwen3VL tokenizer；後者呼叫底層編碼時設定 `disable_weights=True`。因此，不能把傳統 Stable Diffusion 的 `(動作:1.3)` 寫法當成這條流程已支援的權重控制。[2.1 tokenizer](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy/text_encoders/qwen_image21.py)、[Qwen3VL tokenizer](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy/text_encoders/qwen3vl.py)

## 提詞太長會被截斷嗎？

| 項目 | 開源 Qwen-Image-2.1 | QwenCloud `qwen-image-2.1-pro` 編輯 API |
| --- | --- | --- |
| 提詞處理 | 官方 Diffusers 2.1 pipeline 呼叫 processor 時沒有設定 `truncation` 或 `max_sequence_length`；其訓練 README 也明確說明 processor 不截斷 | 文件列出建議最多 4,500 tokens，超量截斷 |
| 負面提詞 | 官方 pipeline 預設 `true_cfg_scale=1.0`；在 CFG 不大於 1 時忽略 negative prompt | 不支援 `negative_prompt` |

開源處理與 CFG 來源：[官方 Diffusers 2.1 pipeline](https://github.com/huggingface/diffusers/blob/main/src/diffusers/pipelines/qwenimage21/pipeline_qwenimage21.py)、[官方訓練 README](https://github.com/huggingface/diffusers/blob/main/examples/dreambooth/README_qwenimage21.md)。雲端限制來源：[QwenCloud 編輯 API](https://docs.qwencloud.com/api-reference/image-generation/qwen-image-editing)。API 限制不能直接套到本機模型。

開源 checkpoint 的 tokenizer `model_max_length` 與文字編碼器 `max_position_embeddings` 都設定為 262,144。這是編碼器設定，**不等於影像模型保證能完整遵循 26 萬 tokens 的提詞**，也不是建議寫到這個長度。[tokenizer 設定](https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/processor/tokenizer_config.json)、[text encoder 設定](https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/text_encoder/config.json)

官方 ComfyUI 的 Qwen3VL tokenizer 使用很大的 `max_length`（99,999,999）避免一般短分段；這同樣不是模型能力或可用記憶體的保證。舊版 Qwen-Image 的短序列設定，不能未查版本就套用到 2.1。[ComfyUI Qwen3VL tokenizer](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy/text_encoders/qwen3vl.py)

## 常站直的可能原因

**以下是診斷推論，並非官方宣告的必然原因。** 官方推薦擴寫短提詞，也提供坐在營火旁的多人物範例，不能據此認定提詞多就只能站直。[官方模型 README](https://github.com/QwenLM/Qwen-Image-2.1)

優先檢查實際送給模型的完整提詞：動作是否只寫「自然姿勢／比愛心」而沒有坐、蹲、彎腰等身體狀態；是否同時要求保留參考圖原姿勢或指定站立；是否把人物參考當作必須完全保留的畫布；動作是否在組合、改寫或輸入流程中遺失。官方編輯改寫器要求保留使用者的動詞、空間關係及狀態，並釐清矛盾；這支持先檢查語義與指令衝突，而非直接認定達到字數上限。[官方編輯 system prompt](https://github.com/QwenLM/Qwen-Image-2.1/blob/main/prompt_rewrite/prompts/system_prompt_edit.txt)

下例是本次撰寫的具體動作範例，並非官方範例或成功保證：

> 讓人物蹲在花叢旁，雙膝彎曲、臀部降低，右手伸向前方的花朵，左手支撐在左膝上；保留參考人物的身分與服裝。

要改姿勢時，保留條款應只保留身分、服裝等必要內容。手勢本身也不能取代全身姿勢；如果只要求單手比愛心，人物維持站立並不違反那項要求。

## 畫質優化看起來接近原圖

官方編輯改寫器把「變更太弱、看起來像未編輯原圖」列為 under-editing。它要求指定變更清楚可見，同時保留其餘內容；保留內容不應被寫成壓低修改強度。品質需求應轉成可觀察的屬性，保留條款則盡量概括，避免反覆重述整張原圖。[官方 I2I system prompt](https://huggingface.co/Qwen/Qwen-Image-2.1-PE-I2I/blob/main/system_prompt.txt)

高清詞也不會自行改變輸出像素。官方 PE 把 2K／4K／8K 視為品質描述，比例與尺寸由獨立欄位／pipeline 參數控制；開源 README 提供原生 2K 尺寸，例如正方形 2048 × 2048。[官方編輯 system prompt](https://github.com/QwenLM/Qwen-Image-2.1/blob/main/prompt_rewrite/prompts/system_prompt_edit.txt)、[官方尺寸與 pipeline 範例](https://github.com/QwenLM/Qwen-Image-2.1)

ComfyUI 官方 `TextEncodeQwenImage21` 會依第一張縮放後參考圖產生空 latent，並提示採樣尺寸與該參考圖一致，否則編輯會偏移。應檢查本專案的參考縮放與輸出 latent 尺寸是否一致。[ComfyUI 官方 2.1 編碼節點](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_qwen.py)

官方 prompt enhancer 是獨立的 T2I／I2I 改寫模型；README 的整合範例把回傳的 `rewritten_prompt` 明確傳給影像 pipeline，不能因為使用 2.1 就假定提詞已自動改寫。[官方 Prompt Rewriting 與整合範例](https://github.com/QwenLM/Qwen-Image-2.1)

### 應優先排查的 seed 重用問題

Diffusers 官方倉庫的一手問題回報 #14824 與本次症狀相近。Qwen contributor `naykun` 指出：以相同 seed、隨機數流與輸出形狀編輯該模型先前產生的圖，會重用生成原圖的初始雜訊，出現 noise replay。原回報者於 2026-09-22 確認換 seed 後編輯恢復，並撤回先前「1024 尺寸造成失敗」的推論；後續也有人回報 ComfyUI 連續編輯換 seed 即改善。[原始回報與後續更正](https://github.com/huggingface/diffusers/issues/14824)

這是可驗證的一手回報，**尚未證明本專案正遇到同一原因**。診斷時應比較原圖和優化工作流的實際 seed 與 target shape，做相同圖片／提詞／尺寸、只換 seed 的對照；不能直接把症狀當成模型的 1024 像素限制。[回報中的對照與更正](https://github.com/huggingface/diffusers/issues/14824)

「接近原圖」本身不能判定是否為應用 BUG。需核對提交與結果紀錄、實際模型／工作流、提詞、尺寸、採樣參數和新輸出；上述官方文件也沒有保證每次人體／手指修復都成功。
