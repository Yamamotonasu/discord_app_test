# macOS環境構築手順書: YouTube生放送 リアルタイム翻訳ボット (WhisperLive + Local LLM)

本ドキュメントは、macOS上のローカル環境にて、韓国語のYouTube生放送をリアルタイムで文字起こしし、ローカルLLMで日本語に翻訳した後、1分ごとにDiscordへ通知するシステムの構築手順です。

## 1. システム構成

* **OS:** macOS (Apple Silicon / Intel)
* **音声認識サーバー:** WhisperLive (backend: faster-whisper)
* **翻訳:** Local LLM (例: Ollama + Llama3/Qwen2.5)
* **通知:** Discord Webhook
* **入力:** yt-dlp (YouTube音声ストリーム取得)

## 2. 事前準備 (Prerequisites)

ターミナル（Terminal.app または iTerm2）を開き、以下のツールをインストールします。

### 2.1 Homebrewでの依存ツールインストール
Pythonの音声処理ライブラリやYouTubeダウンローダーに必要なツールを入れます。

```bash
# Homebrewがインストールされていない場合は公式サイトを参照してください
brew install ffmpeg portaudio yt-dlp
````

### 2.2 Python環境の準備

プロジェクト用のディレクトリを作成し、仮想環境を作ります。

```bash
# ディレクトリ作成
mkdir whisper-discord-bot
cd whisper-discord-bot

# 仮想環境の作成と有効化
python3 -m venv venv
source venv/bin/activate
```

## 3\. WhisperLiveのセットアップ

CollaboraのWhisperLiveリポジトリをクローンし、セットアップします。

```bash
# リポジトリのクローン
git clone [https://github.com/collabora/WhisperLive.git](https://github.com/collabora/WhisperLive.git)

# ディレクトリ移動
cd WhisperLive

# 依存ライブラリのインストール
pip install -r requirements.txt

# 追加で必要なライブラリ（ボット動作用）
pip install requests
```

-----

## 4\. 翻訳ボットの実装

`WhisperLive` フォルダ直下に、以下のPythonスクリプトを作成してください。

**ファイル名:** `discord_trans_bot.py`

```python
import time
import threading
import requests
import subprocess
import json
from whisper_live.client import TranscriptionClient

# ==========================================
# 設定エリア
# ==========================================
# 1. Discord Webhook URL
DISCORD_WEBHOOK_URL = "ここに_Discordの_Webhook_URL_を貼り付け"

# 2. YouTube Live URL (韓国語の放送)
YOUTUBE_URL = "[https://www.youtube.com/watch?v=XXXXXXXX](https://www.youtube.com/watch?v=XXXXXXXX)" 

# 3. 投稿間隔 (秒)
BUFFER_INTERVAL = 60 

# 4. Ollama (ローカルLLM) の設定
OLLAMA_URL = "http://localhost:11434/api/generate"
OLLAMA_MODEL = "llama3" # または "qwen2.5", "gemma2" など
# ==========================================

# テキスト蓄積用のバッファ
text_buffer = []
buffer_lock = threading.Lock()

def translate_with_ollama(korean_text):
    """
    Ollama (Local LLM) を使って翻訳する関数
    """
    if not korean_text.strip():
        return ""

    prompt = (
        f"以下の韓国語の文章を、文脈を補完しながら自然な日本語に翻訳してください。\n"
        f"出力は日本語の翻訳結果のみにしてください。\n\n"
        f"原文: {korean_text}"
    )

    payload = {
        "model": OLLAMA_MODEL,
        "prompt": prompt,
        "stream": False
    }

    try:
        response = requests.post(OLLAMA_URL, json=payload)
        response.raise_for_status()
        return response.json().get('response', '').strip()
    except Exception as e:
        print(f"[Translation Error] {e}")
        return f"(翻訳エラー) {korean_text}"

def discord_poster():
    """
    一定間隔でバッファ内のテキストを翻訳してDiscordに投げるスレッド
    """
    while True:
        time.sleep(BUFFER_INTERVAL)
        
        full_korean_text = ""
        with buffer_lock:
            if not text_buffer:
                continue
            full_korean_text = " ".join(text_buffer)
            text_buffer.clear()

        print(f"\n--- [Interval Check] 文字数: {len(full_korean_text)} ---")
        
        # 翻訳実行
        print("翻訳中...")
        japanese_text = translate_with_ollama(full_korean_text)

        # Discordへ送信
        # メッセージが長すぎる場合は分割する処理が必要ですが今回は簡易化しています
        content = f"**[KR Live 翻訳]**\n{japanese_text}\n\n*(原文: {full_korean_text[:30]}...)*"
        
        data = {"content": content}
        try:
            requests.post(DISCORD_WEBHOOK_URL, json=data)
            print("[Discord] 送信完了")
        except Exception as e:
            print(f"[Discord Error] {e}")

def process_transcription(text):
    """WhisperLiveからのコールバック"""
    # 空文字などを除外
    if "]" in text and "[" in text: # [Music] などのタグを除外したい場合
         return

    with buffer_lock:
        text_buffer.append(text)
        print(f"[Received] {text}")

if __name__ == "__main__":
    # 0. Ollamaの起動確認（簡易）
    try:
        requests.get("http://localhost:11434")
    except:
        print("【エラー】Ollamaが起動していないか、接続できません。")
        print("ターミナルで `ollama serve` を実行してください。")
        exit(1)

    # 1. Discord投稿スレッドを開始
    poster_thread = threading.Thread(target=discord_poster, daemon=True)
    poster_thread.start()

    # 2. YouTube URLの抽出
    print(f"YouTube URL解析中: {YOUTUBE_URL}")
    try:
        command = ["yt-dlp", "-g", YOUTUBE_URL]
        stream_url = subprocess.check_output(command).decode("utf-8").strip().split('\n')[0]
    except Exception as e:
        print("【エラー】YouTubeのURL取得に失敗しました。yt-dlpを確認してください。")
        exit(1)

    # 3. WhisperLiveクライアント接続
    print("WhisperLiveサーバーに接続します...")
    
    try:
        client = TranscriptionClient(
            "localhost",
            9090,
            lang="ko",           # 韓国語固定
            translate=False,     # Whisper側の翻訳はOFF
            model="large-v3-turbo", # サーバー側でモデルを指定している場合はそれに従う
        )
        
        # 音声ストリーム処理開始
        client(stream_url, hls_stream=True, callback=process_transcription)
        
    except KeyboardInterrupt:
        print("停止します。")
```

-----

## 5\. 実行手順

ターミナルを2つ（または3つ）開いて実行します。

### Terminal 1: ローカルLLM (Ollama) の起動

既に起動している場合は不要です。

```bash
ollama serve
```

### Terminal 2: WhisperLiveサーバーの起動

GPUを使える場合は自動的にCUDA等が使用されますが、macOSの場合はCPU実行になる場合が多いです（faster-whisperのCoreML対応状況による）。

```bash
cd ~/path/to/whisper-discord-bot/WhisperLive
source ../venv/bin/activate

# ポート9090でサーバー起動
python run_server.py --port 9090 --backend faster_whisper
```

### Terminal 3: 翻訳ボットの実行

```bash
cd ~/path/to/whisper-discord-bot/WhisperLive
source ../venv/bin/activate

# 実行
python discord_trans_bot.py
```

## 6\. トラブルシューティング

  * **ModuleNotFoundError: No module named '...':**
      * 仮想環境 (`source venv/bin/activate`) に入っているか確認してください。
      * `pip install` で不足しているライブラリを入れてください。
  * **YouTubeのURLが取得できない:**
      * `yt-dlp -U` を実行して、ツールを最新版にアップデートしてください。YouTube側の仕様変更によく影響を受けます。
  * **翻訳されない:**
      * Ollamaのモデル (`llama3` 等) が `ollama pull llama3` でダウンロードされているか確認してください。
