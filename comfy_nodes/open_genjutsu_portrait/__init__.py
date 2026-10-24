"""Core-only, offline portrait performance transfer. No face detector or remote APIs.

Install the pinned MIT LivePortrait core with scripts/portrait/install.py first.
Inputs must be explicit square face crops. Output is a 512px portrait, not a full scene.
"""
from pathlib import Path, PurePosixPath
import gc
import hashlib
import importlib
import json
import sys
import types

ROOT = Path(__file__).resolve().parent
MODEL_NAME = "LivePortrait MIT core 82a4fa6"
SOURCE_COMMIT = "9b294b3d0536135442ea73cb01e6cb3ca7029dd3"
WEIGHT_REVISION = "82a4fa6735ca58432b6ce39301b4b9ee066dea47"
MODEL_FILES = {"F": "base_models/appearance_feature_extractor.pth", "M": "base_models/motion_extractor.pth", "W": "base_models/warping_module.pth", "G": "base_models/spade_generator.pth", "S": "retargeting_models/stitching_retargeting_module.pth"}
REQUIRED_FILES = {f"models/liveportrait/{path}" for path in MODEL_FILES.values()} | {
    "vendor/LICENSE", "vendor/src/live_portrait_wrapper.py", "vendor/src/config/inference_config.py",
    "vendor/src/config/base_config.py", "vendor/src/config/models.yaml", "vendor/src/utils/helper.py",
    "vendor/src/utils/camera.py", "vendor/src/utils/resources/lip_array.pkl", "vendor/src/utils/resources/mask_template.png",
}
_verified = None


def verify_installation():
    global _verified
    manifest = json.loads((ROOT / "installation.json").read_text())
    if manifest.get("sourceCommit") != SOURCE_COMMIT or manifest.get("weightRevision") != WEIGHT_REVISION:
        raise RuntimeError("Portrait installation does not match the pinned core. Run the installer again.")
    files = manifest["files"]
    seen = set()
    signature = [str(ROOT.resolve())]
    for item in files:
        path = PurePosixPath(item["path"])
        if path.is_absolute() or not path.parts or '..' in path.parts or '\\' in item["path"] or item["path"] in seen:
            raise RuntimeError("Invalid or duplicate portrait installation path.")
        file = ROOT / Path(*path.parts)
        if not file.resolve().is_relative_to(ROOT.resolve()) or file.is_symlink():
            raise RuntimeError("Portrait installation files must remain inside this node.")
        if not isinstance(item["bytes"], int) or item["bytes"] < 0 or len(item["sha256"]) != 64:
            raise RuntimeError("Invalid portrait verification record.")
        stat = file.stat()
        signature.append((item["path"], item["bytes"], item["sha256"], stat.st_size, stat.st_mtime_ns))
        seen.add(item["path"])
    if not REQUIRED_FILES.issubset(seen):
        raise RuntimeError("Portrait installation is incomplete. Run the installer again.")
    signature = tuple(signature)
    if signature != _verified:
        for item in files:
            file = ROOT / item["path"]
            with file.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            if file.stat().st_size != item["bytes"] or digest != item["sha256"]:
                raise RuntimeError(f"Pinned portrait file failed verification: {item['path']}. Run the installer again.")
        _verified = signature
    return manifest


def core_modules():
    # A private package avoids shadowing ComfyUI or another custom node's `src`.
    name = "_open_genjutsu_portrait_core_" + hashlib.sha256(str(ROOT.resolve()).encode()).hexdigest()[:16]
    if name not in sys.modules:
        package = types.ModuleType(name)
        package.__path__ = [str(ROOT / "vendor" / "src")]
        sys.modules[name] = package
    wrapper = importlib.import_module(f"{name}.live_portrait_wrapper")
    config = importlib.import_module(f"{name}.config.inference_config")
    camera = importlib.import_module(f"{name}.utils.camera")
    return wrapper.LivePortraitWrapper, config.InferenceConfig, camera.get_rotation_matrix


class OpenGenjutsuPortrait:
    @classmethod
    def INPUT_TYPES(cls):
        try:
            verify_installation()
            available = [MODEL_NAME]
        except (OSError, ValueError, KeyError, RuntimeError):
            available = []
        return {"required": {
            "source_images": ("IMAGE",), "reference_image": ("IMAGE",),
            "model": (available,),
            "frames": ("INT", {"default": 33, "min": 1, "max": 49, "step": 4}),
            "motion_strength": ("FLOAT", {"default": .35, "min": 0, "max": 1, "step": .05}),
        }}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "animate"
    CATEGORY = "Open Genjutsu/local"
    DESCRIPTION = "Animate an explicit square reference crop from square human performance crops. Small frontal motion works best. No background or full-body replacement. Offline MIT core only."

    def animate(self, source_images, reference_image, model, frames, motion_strength):
        import numpy as np
        import torch
        import comfy.model_management as management
        from comfy.utils import ProgressBar
        if model != MODEL_NAME:
            raise ValueError("Choose the installed pinned MIT core model.")
        if type(frames) is not int or not 1 <= frames <= 49 or frames % 4 != 1:
            raise ValueError("Choose 4n+1 frames, up to 49.")
        if not isinstance(motion_strength, (int, float)) or not 0 <= motion_strength <= 1:
            raise ValueError("Motion strength must be between 0 and 1.")
        if source_images.ndim != 4 or tuple(source_images.shape[1:]) != (256, 256, 3) or not frames <= len(source_images) <= 49:
            raise ValueError("Prepare the requested number of 256×256 RGB performance crops, at most 49.")
        if tuple(reference_image.shape) != (1, 256, 256, 3):
            raise ValueError("Prepare one 256×256 RGB reference face crop.")
        if not torch.isfinite(source_images[:frames]).all().item() or not torch.isfinite(reference_image).all().item():
            raise ValueError("Portrait inputs contain invalid pixels. Prepare finite RGB images.")
        verify_installation()
        management.throw_exception_if_processing_interrupted()
        device = management.get_torch_device()
        if device.type not in {"cpu", "mps", "cuda"}:
            raise RuntimeError("This portrait core supports ComfyUI CPU, MPS or CUDA devices only.")
        management.unload_all_models()
        Wrapper, Config, rotation = core_modules()
        cfg = Config()
        base = ROOT / "models" / "liveportrait"
        for field, file in MODEL_FILES.items():
            setattr(cfg, f"checkpoint_{field}", str(base / file))
        cfg.flag_force_cpu = device.type == "cpu"
        if device.type == "cuda":
            cfg.device_id = device.index if device.index is not None else 0
        cfg.flag_use_half_precision = False
        cfg.flag_do_torch_compile = False
        cfg.flag_do_crop = cfg.flag_pasteback = False
        cfg.flag_normalize_lip = cfg.flag_eye_retargeting = cfg.flag_lip_retargeting = cfg.flag_source_video_eye_retargeting = False
        wrapper = features = prepared = source = xs = rs = driving = xd = None
        initial = initial_rotation = rd = pose = expression = scale = translation = None
        decoded = None
        try:
            with torch.inference_mode():
                wrapper = Wrapper(cfg)
                ref = (reference_image[0].detach().cpu().clamp(0, 1).numpy() * 255).round().astype(np.uint8)
                prepared = wrapper.prepare_source(ref)
                source = wrapper.get_kp_info(prepared)
                xs = wrapper.transform_keypoint(source)
                rs = rotation(source['pitch'], source['yaw'], source['roll'])
                features = wrapper.extract_feature_3d(prepared)
                progress = ProgressBar(frames)
                outputs = []
                initial = initial_rotation = None
                for index in range(frames):
                    management.throw_exception_if_processing_interrupted()
                    image = (source_images[index].detach().cpu().clamp(0, 1).numpy() * 255).round().astype(np.uint8)
                    driving = wrapper.get_kp_info(wrapper.prepare_source(image))
                    rd = rotation(driving['pitch'], driving['yaw'], driving['roll'])
                    if initial is None:
                        initial, initial_rotation = driving, rd
                    pose = rd @ initial_rotation.permute(0, 2, 1) @ rs
                    expression = source['exp'] + driving['exp'] - initial['exp']
                    scale = source['scale'] * (driving['scale'] / initial['scale'])
                    translation = (source['t'] + driving['t'] - initial['t']).clone()
                    translation[..., 2] = 0
                    xd = scale[..., None] * (source['kp'] @ pose + expression) + translation[:, None, :]
                    xd = wrapper.stitching(xs, xd)
                    xd = xs + (xd - xs) * motion_strength
                    decoded = wrapper.warp_decode(features, xs, xd)
                    result = wrapper.parse_output(decoded['out'])[0]
                    outputs.append(torch.from_numpy(result.copy()).float().div_(255))
                    decoded = None
                    progress.update_absolute(index + 1, frames)
                    management.throw_exception_if_processing_interrupted()
                return (torch.stack(outputs),)
        finally:
            wrapper = features = prepared = source = xs = rs = driving = xd = None
            initial = initial_rotation = rd = pose = expression = scale = translation = decoded = None
            gc.collect()
            management.soft_empty_cache()


NODE_CLASS_MAPPINGS = {"OpenGenjutsuPortrait": OpenGenjutsuPortrait}
NODE_DISPLAY_NAME_MAPPINGS = {"OpenGenjutsuPortrait": "Open Genjutsu · Portrait Performance"}
