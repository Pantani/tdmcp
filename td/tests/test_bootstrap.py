import importlib.util
import io
import os
from pathlib import Path
import stat
import tempfile
import unittest
import zipfile


class _Response:
    def __init__(self, data):
        self._data = data

    def read(self):
        return self._data


def _zip_bytes(entries):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for entry in entries:
            if len(entry) == 2:
                name, body = entry
                zf.writestr(name, body)
            else:
                name, body, mode = entry
                info = zipfile.ZipInfo(name)
                info.external_attr = mode << 16
                zf.writestr(info, body)
    return buf.getvalue()


class BootstrapExtractionTests(unittest.TestCase):
    def setUp(self):
        os.environ["TDMCP_BOOTSTRAP_SKIP_RUN"] = "1"
        path = Path(__file__).resolve().parents[1] / "bootstrap.py"
        spec = importlib.util.spec_from_file_location("tdmcp_bootstrap_test", path)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.bootstrap = module

    def tearDown(self):
        os.environ.pop("TDMCP_BOOTSTRAP_SKIP_RUN", None)

    def _fetch_from_zip(self, data, dest):
        original = self.bootstrap.urllib.request.urlopen
        self.bootstrap.urllib.request.urlopen = lambda *_args, **_kwargs: _Response(data)
        try:
            return self.bootstrap.fetch_modules("https://example.invalid/repo.zip", dest)
        finally:
            self.bootstrap.urllib.request.urlopen = original

    def test_default_repo_zip_is_release_tag_pinned(self):
        self.assertRegex(
            self.bootstrap.REPO_ZIP,
            r"^https://github\.com/Pantani/tdmcp/archive/refs/tags/v\d+\.\d+\.\d+\.zip$",
        )
        self.assertNotIn("/refs/heads/", self.bootstrap.REPO_ZIP)
        self.assertNotIn("/raw/main/", self.bootstrap.__doc__ or "")

    def test_extracts_only_safe_module_entries(self):
        data = _zip_bytes(
            [
                ("repo-main/README.md", b"ignored"),
                ("repo-main/td/modules/mcp/install.py", b"print('ok')\n"),
            ],
        )
        with tempfile.TemporaryDirectory() as tmp:
            modules_dir = Path(self._fetch_from_zip(data, tmp))

            self.assertEqual((modules_dir / "mcp" / "install.py").read_bytes(), b"print('ok')\n")
            self.assertFalse((Path(tmp) / "README.md").exists())

    def test_rejects_traversal_entries(self):
        data = _zip_bytes([("repo-main/td/modules/../../escape.py", b"bad")])
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(RuntimeError, "unsafe archive entry"):
                self._fetch_from_zip(data, tmp)

            self.assertFalse((Path(tmp).parent / "escape.py").exists())

    def test_rejects_symlink_entries(self):
        link_mode = stat.S_IFLNK | 0o777
        data = _zip_bytes([("repo-main/td/modules/mcp/link.py", b"target.py", link_mode)])
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(RuntimeError, "symlink archive entry"):
                self._fetch_from_zip(data, tmp)


if __name__ == "__main__":
    unittest.main()
