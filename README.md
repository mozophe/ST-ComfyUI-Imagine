# Comfy Imagine

A SillyTavern extension that generates images on demand by reading the current chat context, sending it to an LLM to write a Stable Diffusion prompt, and posting it to a local ComfyUI instance.

## Requirements

- SillyTavern `release` v1.18.0+
- A running ComfyUI instance accessible over your local network, started with:
  ```
  python main.py --listen
  ```
  (`--listen` without specifying `127.0.0.1` so it binds to all interfaces)
- An OpenAI-compatible LLM API endpoint (e.g. nano-gpt, OpenAI, a local Ollama server)

## Installation

In SillyTavern's Extension Manager, install from GitHub using your private repo URL. A PAT already configured on the Pi will be used automatically.

## Setup

1. **ComfyUI Base URL** — set to the Windows machine's local IP, e.g. `http://192.168.1.50:8188`. Use **Test Connection** to verify.
2. **LLM** — enter your API base URL, API key, and model name.
3. **Upload a Workflow** — export your ComfyUI workflow in **API format** (enable Dev Mode in ComfyUI → Export API), then upload it here. Workflows are stored in your SillyTavern settings — no files are written to the server.
4. **Select Active Workflow** — choose the workflow to use for generation.
5. **Adjust Generation Settings** — image count (1–8), sender name for injected messages.

## Usage

Type `/imagine` in the chat input or attach it to a Quick Reply button. The extension will:

1. Gather the current character card, user persona, and chat history
2. Ask the configured LLM to write a Stable Diffusion prompt
3. Post the prompt to ComfyUI and wait for the result
4. Inject the generated image into chat as a message from "Camera" (hidden from the main model)

A **Cancel** button appears in the send bar during generation.

## Security Note

The LLM API key is stored in SillyTavern's `settings.json` in plain text. Do not commit or share that file.

## Workflow Notes

- Workflows must be in **ComfyUI API export format** (not the standard UI format).
- The extension injects the generated prompt into the first `CLIPTextEncode` node (positive conditioning) and the negative prompt (if set) into the second `CLIPTextEncode` node.
- If image count > 1, the KSampler seed is randomised for each job.
