"""CPU-free protocol tests: fake source/weights, no runtime install or inference.

Run: python3 -m unittest discover -s tests -p python_adapter_test.py -v
"""
from contextlib import nullcontext
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch, Mock

APP = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


installer = load('portrait_installer_tests', APP / 'scripts/portrait/install.py')
adapter = load('portrait_adapter_tests', APP / 'comfy_nodes/open_genjutsu_portrait/__init__.py')


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='open-genjutsu-portrait-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        self.comfy = self.root / 'fake-comfy'
        (self.comfy / 'custom_nodes').mkdir(parents=True)
        (self.comfy / 'main.py').write_text('# test fixture, never imported\n')
        self.target = self.comfy / 'custom_nodes/open_genjutsu_portrait'
        self.weights = self.root / 'weights'
        self.source_files = {
            'LICENSE': 'MIT fixture\n',
            'src/live_portrait_wrapper.py': '# committed core fixture\n',
            'src/config/inference_config.py': '# fixture\n',
            'src/config/crop_config.py': '# must be excluded\n',
            'src/config/argument_config.py': '# must be excluded\n',
            'src/modules/fixture.py': '# fixture\n',
            'src/utils/helper.py': '# fixture\n',
            'src/utils/face_analysis.py': '# must be excluded\n',
        }
        for name, data in self.source_files.items():
            file = self.source / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(data)
        self.git('init', '--quiet')
        self.git('add', '.')
        self.git('-c', 'user.name=Codex fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'test fixture')
        commit = self.git('rev-parse', 'HEAD').strip()
        self.pin = {**installer.PIN, 'sourceCommit': commit, 'models': []}
        for index, original in enumerate(installer.PIN['models']):
            data = f'owned tiny weight fixture {index}'.encode()
            item = {**original, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
            self.pin['models'].append(item)
            file = self.weights / item['path']
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(data)
        self.pin['totalBytes'] = sum(item['bytes'] for item in self.pin['models'])

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.source), *args], text=True)

    def run_install(self, offline_weights=True):
        args = ['--comfy-dir', str(self.comfy), '--source-dir', str(self.source)]
        if offline_weights:
            args += ['--weights-dir', str(self.weights)]
        with patch.object(installer, 'PIN', self.pin):
            installer.main(args)

    def test_offline_install_is_atomic_reads_committed_blobs_and_excludes_face_stack(self):
        (self.source / 'src/live_portrait_wrapper.py').write_text('# dirty local version must not ship\n')
        real_rename = installer.os.rename
        real_check_output = installer.subprocess.check_output
        calls = []

        def inspect_rename(source, target):
            self.assertFalse(self.target.exists())
            self.assertTrue(Path(source).parent.name.endswith('.disabled'))
            self.assertTrue((Path(source) / 'installation.json').is_file())
            return real_rename(source, target)

        def inspect_git(*args, **kwargs):
            calls.append(kwargs.get('env', {}))
            return real_check_output(*args, **kwargs)

        with patch.object(installer.os, 'rename', side_effect=inspect_rename), patch.object(installer.subprocess, 'check_output', side_effect=inspect_git), patch.object(installer.urllib.request, 'urlopen', side_effect=AssertionError('offline installation used HTTP')):
            self.run_install()
        self.assertTrue(calls)
        self.assertTrue(all(env.get('GIT_NO_LAZY_FETCH') == '1' for env in calls))
        self.assertEqual((self.target / 'vendor/src/live_portrait_wrapper.py').read_text(), '# committed core fixture\n')
        for name in ('vendor/src/utils/face_analysis.py', 'vendor/src/config/crop_config.py', 'vendor/src/config/argument_config.py'):
            self.assertFalse((self.target / name).exists())
        manifest = json.loads((self.target / 'installation.json').read_text())
        self.assertEqual(len([item for item in manifest['files'] if item['path'].startswith('models/')]), 5)
        self.assertFalse(list(self.target.parent.glob('.open_genjutsu_portrait-*.disabled')))

    def test_bad_weights_never_enable_partial_node(self):
        file = self.weights / self.pin['models'][0]['path']
        file.write_bytes(file.read_bytes() + b'oversize')
        with self.assertRaisesRegex(RuntimeError, 'exceeded its pinned size'):
            self.run_install()
        self.assertFalse(self.target.exists())
        self.assertFalse(list(self.target.parent.glob('.open_genjutsu_portrait-*.disabled')))

    def test_http_body_is_bounded_and_existing_install_is_preserved(self):
        body = io.BytesIO(b'x' * (self.pin['models'][0]['bytes'] + 100))
        with patch.object(installer.urllib.request, 'urlopen', return_value=nullcontext(body)), self.assertRaisesRegex(RuntimeError, 'exceeded its pinned size'):
            self.run_install(offline_weights=False)
        self.assertLess(body.tell(), 100)  # read exact expected bytes plus one, not the whole body
        self.assertFalse(self.target.exists())
        self.target.mkdir()
        marker = self.target / 'keep.txt'
        marker.write_text('preserve')
        with self.assertRaises(SystemExit):
            self.run_install()
        self.assertEqual(marker.read_text(), 'preserve')


class AdapterTests(unittest.TestCase):
    def make_install(self, root):
        files = []
        for name in sorted(adapter.REQUIRED_FILES):
            data = name.encode()
            file = root / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(data)
            files.append({'path': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
        manifest = {'sourceCommit': adapter.SOURCE_COMMIT, 'weightRevision': adapter.WEIGHT_REVISION, 'files': files}
        (root / 'installation.json').write_text(json.dumps(manifest))
        return manifest

    def test_missing_tampered_and_escaping_records_fail_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            manifest = self.make_install(root)
            with patch.object(adapter, 'ROOT', root), patch.object(adapter, '_verified', None):
                adapter.verify_installation()
                file = root / manifest['files'][0]['path']
                file.write_bytes(b'broken')
                with self.assertRaisesRegex(RuntimeError, 'failed verification'):
                    adapter.verify_installation()
            manifest = self.make_install(root)
            manifest['files'].append({'path': '../escape', 'bytes': 0, 'sha256': '0' * 64})
            (root / 'installation.json').write_text(json.dumps(manifest))
            with patch.object(adapter, 'ROOT', root), self.assertRaisesRegex(RuntimeError, 'Invalid or duplicate'):
                adapter.verify_installation()
            manifest['files'] = manifest['files'][1:-1]
            (root / 'installation.json').write_text(json.dumps(manifest))
            with patch.object(adapter, 'ROOT', root), self.assertRaisesRegex(RuntimeError, 'incomplete'):
                adapter.verify_installation()

    def test_private_package_never_replaces_global_src(self):
        sentinel = types.ModuleType('src')
        imported = []

        def fake_import(name):
            imported.append(name)
            return types.SimpleNamespace(LivePortraitWrapper=object, InferenceConfig=object, get_rotation_matrix=object)

        with patch.dict(sys.modules, {'src': sentinel}), patch.object(adapter.importlib, 'import_module', side_effect=fake_import):
            adapter.core_modules()
            self.assertIs(sys.modules['src'], sentinel)
            self.assertTrue(all(name.startswith('_open_genjutsu_portrait_core_') for name in imported))

    def stub_modules(self, device='cpu'):
        management = types.ModuleType('comfy.model_management')
        management.get_torch_device = Mock(return_value=types.SimpleNamespace(type=device, index=2))
        management.throw_exception_if_processing_interrupted = Mock()
        management.unload_all_models = Mock()
        management.soft_empty_cache = Mock()
        torch = types.ModuleType('torch')
        torch.isfinite = lambda tensor: types.SimpleNamespace(all=lambda: types.SimpleNamespace(item=lambda: True))
        torch.inference_mode = nullcontext
        comfy = types.ModuleType('comfy')
        comfy.model_management = management
        utils = types.ModuleType('comfy.utils')
        utils.ProgressBar = Mock()
        return management, {'numpy': types.ModuleType('numpy'), 'torch': torch, 'comfy': comfy, 'comfy.model_management': management, 'comfy.utils': utils}

    def test_device_policy_and_constructor_error_cleanup_without_model_execution(self):
        class TensorFixture:
            ndim = 4
            shape = (5, 256, 256, 3)
            def __len__(self): return 5
            def __getitem__(self, index): return self
        source = TensorFixture()
        reference = types.SimpleNamespace(shape=(1, 256, 256, 3))
        for device in ('cpu', 'cuda', 'mps'):
            with self.subTest(device=device):
                management, modules = self.stub_modules(device)
                configs = []
                def wrapper(config):
                    configs.append(config)
                    raise RuntimeError('fixture stops before any model execution')
                with patch.dict(sys.modules, modules), patch.object(adapter, 'verify_installation'), patch.object(adapter, 'core_modules', return_value=(wrapper, types.SimpleNamespace, None)), self.assertRaisesRegex(RuntimeError, 'fixture stops'):
                    adapter.OpenGenjutsuPortrait().animate(source, reference, adapter.MODEL_NAME, 5, .35)
                self.assertEqual(configs[0].flag_force_cpu, device == 'cpu')
                if device == 'cuda':
                    self.assertEqual(configs[0].device_id, 2)
                management.soft_empty_cache.assert_called_once()
        management, modules = self.stub_modules()
        management.throw_exception_if_processing_interrupted.side_effect = RuntimeError('fixture interrupted')
        with patch.dict(sys.modules, modules), patch.object(adapter, 'verify_installation'), patch.object(adapter, 'core_modules') as core, self.assertRaisesRegex(RuntimeError, 'interrupted'):
            adapter.OpenGenjutsuPortrait().animate(source, reference, adapter.MODEL_NAME, 5, .35)
        core.assert_not_called()
        management.unload_all_models.assert_not_called()


if __name__ == '__main__':
    unittest.main()
