# ComfyUI-Imagine

A SillyTavern extension that generates images on demand by reading the current chat context, sending it to an LLM to write a Stable Diffusion prompt, and posting it to a ComfyUI instance.

## Requirements

- SillyTavern `release` v1.18.0+
- A running ComfyUI instance, started with:
  ```
  python main.py --listen 0.0.0.0 --port 8188 --enable-cors-header
  ```
  - `--listen 0.0.0.0` — accept connections from other machines on the network
  - `--enable-cors-header` — required when SillyTavern runs on a **different machine** (e.g. a Raspberry Pi); without it the browser blocks cross-origin requests even if the port is reachable via `curl`
- An OpenAI-compatible LLM API endpoint (e.g. nano-gpt, OpenAI, a local Ollama server)

## Installation

In SillyTavern's Extension Manager, paste the GitHub repo URL and install.

## Setup

1. **ComfyUI Base URL** — set to the machine's IP and port, e.g. `http://192.168.1.50:8188`. Click **Test ComfyUI Connection** to verify.
2. **LLM** — enter your API base URL, API key, and model name. Click **Test API Connection** to verify.
3. **Upload a Workflow** — export your ComfyUI workflow in **API format** (enable Dev Mode in ComfyUI → Save API Format), then upload it here. Workflows are stored in your SillyTavern settings — no files are written to the server.
4. **Select Active Workflow** — choose the workflow to use. Use the 🗑 button to delete workflows you no longer need.
5. **Generation Settings** — image count (1–8), sender name for injected messages.

## Usage

Type `/imagine` in the chat input or attach it to a Quick Reply button. The extension will:

1. Gather the current character card, user persona, and chat history
2. Ask the configured LLM to write a Stable Diffusion prompt
3. Post the prompt to ComfyUI and wait for the result
4. Inject the generated image into chat as a message from "Camera" (hidden from the main model)

Use ST's built-in **Abort** button to cancel generation mid-flight.

Each generated image message has a ⓘ button in the message action row. Click it to open a debug modal showing the system prompt, the full LLM context (character + persona + chat log), and the generated image prompt.

## Security Note

The LLM API key is stored in SillyTavern's `settings.json` in plain text. Do not commit or share that file.

## Workflow Notes

- Workflows must be in **ComfyUI API export format** (not the standard UI format).
- The extension injects the LLM-generated prompt into the first `CLIPTextEncode` node (positive conditioning) and the negative prompt (if set) into the second.
- If image count > 1, the KSampler seed is randomised for each job.
