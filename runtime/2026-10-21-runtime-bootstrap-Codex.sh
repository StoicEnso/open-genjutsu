#!/usr/bin/env bash
# Reconstructs the observed 2026-10-21 arm64/macOS runtime in a NEW folder.
# Syntax-checked only as a whole; underlying pinned runtime was installed/tested.
# Downloads ~8.22 GB of model files plus Python wheels/source. No paid service.
set -euo pipefail
runtime_root="${1:?Pass a NEW absolute runtime directory}"
case "$runtime_root" in /*) ;; *) echo 'Runtime path must be absolute' >&2; exit 2;; esac
if [[ -e "$runtime_root" ]]; then echo 'Refusing to modify an existing runtime' >&2; exit 2; fi
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
python_bin="${OPEN_GENJUTSU_PYTHON:-/opt/homebrew/opt/python@3.12/bin/python3.12}"
"$python_bin" -I -S -c 'import platform; assert platform.system()=="Darwin" and platform.machine()=="arm64", "This recipe was verified on Apple Silicon macOS only"'
mkdir -p "$runtime_root"
"$python_bin" -m venv "$runtime_root/.venv"
"$runtime_root/.venv/bin/python" -m pip install -r "$script_dir/2026-10-21-runtime-packages-Codex.txt"
git init "$runtime_root/ComfyUI"
git -C "$runtime_root/ComfyUI" remote add origin https://github.com/Comfy-Org/ComfyUI.git
git -C "$runtime_root/ComfyUI" fetch --depth 1 origin d52a7a5ef60b36062f7c3c69bd774f4c98b56eb0
git -C "$runtime_root/ComfyUI" checkout --detach FETCH_HEAD
git init "$runtime_root/ComfyUI/custom_nodes/ComfyUI-GGUF"
git -C "$runtime_root/ComfyUI/custom_nodes/ComfyUI-GGUF" remote add origin https://github.com/city96/ComfyUI-GGUF.git
git -C "$runtime_root/ComfyUI/custom_nodes/ComfyUI-GGUF" fetch --depth 1 origin 6ea2651e7df66d7585f6ffee804b20e92fb38b8a
git -C "$runtime_root/ComfyUI/custom_nodes/ComfyUI-GGUF" checkout --detach FETCH_HEAD
cp "$script_dir/2026-10-21-model-download-manifest-Codex.json" "$runtime_root/2026-10-21-model-download-manifest-Codex.json"
"$runtime_root/.venv/bin/python" - "$runtime_root" <<'PYMODELS'
import hashlib, json, os, pathlib, subprocess, sys
root=pathlib.Path(sys.argv[1])
manifest=json.loads((root/'2026-10-21-model-download-manifest-Codex.json').read_text())
for model in manifest['models']:
    final=root/model['path']; final.parent.mkdir(parents=True,exist_ok=True)
    temp=pathlib.Path(str(final)+'.download')
    url='https://huggingface.co/{repo}/resolve/{revision}/{source}'.format(**model)
    print('Downloading',model['path'],model['bytes'],'bytes',flush=True)
    subprocess.run(['curl','--fail','--location','--retry','3','--continue-at','-','--output',str(temp),url],check=True)
    assert temp.stat().st_size==model['bytes'],f'Length mismatch: {temp}'
    digest=hashlib.sha256()
    with temp.open('rb') as source:
        for block in iter(lambda:source.read(8*1024*1024),b''): digest.update(block)
    assert digest.hexdigest()==model['sha256'],f'SHA256 mismatch: {temp}'
    os.replace(temp,final)
    print('Verified and published',final,flush=True)
(root/'extra_model_paths.yaml').write_text('open_genjutsu:\n  base_path: '+json.dumps(str(root))+'\n  diffusion_models: models/diffusion_models\n  text_encoders: models/text_encoders\n  vae: models/vae\n')
PYMODELS
"$runtime_root/.venv/bin/python" - "$runtime_root" <<'PYLAUNCH'
import pathlib, shlex, sys
root=pathlib.Path(sys.argv[1])
commands={
    'core': [str(root/'.venv/bin/python'), '-u', str(root/'ComfyUI/main.py'), '--listen', '127.0.0.1', '--port', '8188', '--offline', '--lowvram', '--cpu-vae', '--force-fp16', '--use-pytorch-cross-attention', '--preview-method', 'none', '--reserve-vram', '3', '--extra-model-paths-config', str(root/'extra_model_paths.yaml')],
    'proxy': [str(root/'.venv/bin/comfy-api-proxy'), 'run', '--host', '127.0.0.1', '--port', '8189', '--comfyui', 'http://127.0.0.1:8188', '--state-dir', str(root/'proxy-state')],
}
for role, command in commands.items():
    script=root/f'2026-10-21-start-{role}-Codex.sh'
    script.write_text('#!/usr/bin/env bash\nset -euo pipefail\nunset COMFY_API_KEY\nexport PYTORCH_ENABLE_MPS_FALLBACK=1\nexec '+shlex.join(command)+'\n')
    script.chmod(0o755)
PYLAUNCH
printf '%s\n' 'Setup complete. Launch the generated core and proxy scripts in separate terminals. In the app Engine panel, use SDK proxy http://127.0.0.1:8189 and native ComfyUI http://127.0.0.1:8188. No cloud credentials. Start at 256x256 and 17 frames.'
