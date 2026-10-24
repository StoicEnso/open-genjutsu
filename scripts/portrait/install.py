#!/usr/bin/env python3
"""Install only the pinned MIT portrait core into a user's explicit Comfy directory.

No pip changes, credentials, cloud calls or inference. Model downloads total 522MB.
Use --source-dir /pinned/LivePortrait --weights-dir /models for offline installation.
"""
from pathlib import Path, PurePosixPath
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import urllib.request

APP = Path(__file__).resolve().parents[2]
PIN = json.loads((Path(__file__).with_name('models.json')).read_text())
UTILS = {'__init__.py', 'timer.py', 'helper.py', 'camera.py', 'retargeting_utils.py', 'rprint.py', 'resources/lip_array.pkl', 'resources/mask_template.png'}
CONFIG = {'__init__.py', 'base_config.py', 'inference_config.py', 'models.yaml'}


def selected(path):
    return (path in {'LICENSE', 'src/__init__.py', 'src/live_portrait_wrapper.py'}
            or path.startswith('src/modules/')
            or path.startswith('src/config/') and path.removeprefix('src/config/') in CONFIG
            or path.startswith('src/utils/') and path.removeprefix('src/utils/') in UTILS)


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def relative_path(value):
    path = PurePosixPath(value)
    if path.is_absolute() or not path.parts or any(part in {'.', '..'} for part in path.parts) or '\\' in value:
        raise RuntimeError(f'Invalid pinned relative path: {value}')
    return Path(*path.parts)


def copy_verified(source, destination, item):
    """Bound both offline copies and HTTP bodies by the pinned byte count."""
    remaining = item['bytes']
    sha = hashlib.sha256()
    with destination.open('xb') as output:
        while remaining:
            block = source.read(min(1024 * 1024, remaining))
            if not block:
                raise RuntimeError(f"Model was truncated: {item['path']}. Nothing installed.")
            output.write(block)
            sha.update(block)
            remaining -= len(block)
        if source.read(1):
            raise RuntimeError(f"Model exceeded its pinned size: {item['path']}. Nothing installed.")
    if sha.hexdigest() != item['sha256']:
        raise RuntimeError(f"Model hash mismatch: {item['path']}. Nothing installed.")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--comfy-dir', type=Path, required=True)
    parser.add_argument('--source-dir', type=Path)
    parser.add_argument('--weights-dir', type=Path, help='Directory containing liveportrait/base_models, etc.')
    args = parser.parse_args(argv)
    comfy = args.comfy_dir.expanduser().resolve()
    if not (comfy / 'main.py').is_file() or not (comfy / 'custom_nodes').is_dir():
        parser.error('--comfy-dir must name an existing ComfyUI checkout.')
    target = comfy / 'custom_nodes' / 'open_genjutsu_portrait'
    if target.exists():
        parser.error(f'{target} already exists. Preserve or remove your previous installation explicitly before reinstalling.')
    # ComfyUI ignores .disabled directories. Staging beside the final target also
    # keeps the final rename on one filesystem, including external Comfy drives.
    with tempfile.TemporaryDirectory(prefix='.open_genjutsu_portrait-', suffix='.disabled', dir=target.parent) as temp:
        temp = Path(temp)
        source = args.source_dir.expanduser().resolve() if args.source_dir else temp / 'source'
        git_env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0'}
        if args.source_dir:
            # A partial clone must fail rather than fetch blobs during offline use.
            git_env['GIT_NO_LAZY_FETCH'] = '1'
        if not args.source_dir:
            subprocess.run(['git', 'clone', '--quiet', '--filter=blob:none', '--no-checkout', 'https://github.com/KwaiVGI/LivePortrait.git', str(source)], check=True, env=git_env)
        # Read committed blobs, never locally modified working files or executable helpers.
        commit = subprocess.check_output(['git', '-C', str(source), 'rev-parse', f"{PIN['sourceCommit']}^{{commit}}"], text=True, env=git_env).strip()
        if commit != PIN['sourceCommit']:
            raise RuntimeError('Source revision mismatch.')
        stage = temp / 'stage'
        stage.mkdir()
        for filename in ('__init__.py', 'THIRD_PARTY_LICENSE.txt'):
            shutil.copyfile(APP / 'comfy_nodes' / 'open_genjutsu_portrait' / filename, stage / filename)
        files = []
        paths = subprocess.check_output(['git', '-C', str(source), 'ls-tree', '-r', '--name-only', commit], text=True, env=git_env).splitlines()
        for relative in filter(selected, paths):
            data = subprocess.check_output(['git', '-C', str(source), 'show', f'{commit}:{relative}'], env=git_env)
            file = stage / 'vendor' / relative_path(relative)
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(data)
            files.append({'path': str(file.relative_to(stage)), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
        for item in PIN['models']:
            file = stage / 'models' / relative_path(item['path'])
            file.parent.mkdir(parents=True, exist_ok=True)
            if args.weights_dir:
                with (args.weights_dir.expanduser().resolve() / relative_path(item['path'])).open('rb') as source_file:
                    copy_verified(source_file, file, item)
            else:
                expected_url = f"https://huggingface.co/{PIN['repo']}/resolve/{PIN['revision']}/{item['path']}"
                if item['url'] != expected_url:
                    raise RuntimeError('The model URL does not match its pinned official revision.')
                with urllib.request.urlopen(item['url'], timeout=120) as response:
                    copy_verified(response, file, item)
            files.append({**{key: item[key] for key in ('bytes', 'sha256')}, 'path': str(file.relative_to(stage))})
        manifest = {'version': 1, 'sourceCommit': commit, 'weightRevision': PIN['revision'], 'license': PIN['license'], 'files': files, 'excluded': ['InsightFace', 'face detectors', 'landmark weights', 'animal models', 'automatic downloads at execution']}
        (stage / 'installation.json').write_text(json.dumps(manifest, indent=2) + '\n')
        if target.exists():
            raise RuntimeError('Another installation appeared. It was preserved; nothing replaced.')
        os.rename(stage, target)
    print(f'Installed pinned MIT portrait core into {target}. Restart ComfyUI. No inference or provider charges occurred.')


if __name__ == '__main__':
    main()
