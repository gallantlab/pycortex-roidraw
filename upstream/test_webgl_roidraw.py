"""Tests for the optional ROI/sulcus-drawing feature (cortex.webgl.make_static(roidraw=True))."""
import cortex.webgl  # noqa: F401  (ensures cortex.webgl is importable)
from cortex.webgl import serve
from cortex.webgl.FallbackLoader import FallbackLoader


def _render_base_template(roidraw):
    """Render the base webgl template with the given `roidraw` flag (no subject needed)."""
    loader = FallbackLoader([serve.cwd])
    tpl = loader.load("template.html")
    html = tpl.generate(
        title="test",
        leapmotion=False,
        python_interface=False,
        roidraw=roidraw,
        tour=False,  # harmless if the template has no tour block; keeps this test rendering if it does
        colormaps=[("RdBu_r", "colormaps/RdBu_r.png")],
        default_cmap="RdBu_r",
    )
    return html.decode("utf-8") if isinstance(html, bytes) else html


def test_roidraw_include_present_when_enabled():
    html = _render_base_template(True)
    assert "resources/js/roidraw.js" in html
    assert "window.ROIDraw.autoAttach();" in html


def test_roidraw_include_absent_by_default():
    html = _render_base_template(False)
    assert "resources/js/roidraw.js" not in html
    assert "ROIDraw" not in html
