"""GeocodeResult model — unit tests (offline, no network, no key)."""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from models.geocode import GeocodeResult


def test_geocode_result_construct_ok():
    g = GeocodeResult(
        lat=35.6812,
        lng=139.7671,
        name="Tokyo Station",
        formatted_address="Marunouchi, Chiyoda, Tokyo",
        mapbox_id="dXJuOm1ieHBvaTo0NzI1NjI3",
    )
    assert abs(g.lat - 35.6812) < 1e-9
    assert abs(g.lng - 139.7671) < 1e-9
    assert g.name == "Tokyo Station"
    assert g.formatted_address == "Marunouchi, Chiyoda, Tokyo"
    assert g.mapbox_id == "dXJuOm1ieHBvaTo0NzI1NjI3"


def test_geocode_result_optional_fields_default_none():
    g = GeocodeResult(lat=0.0, lng=0.0)
    assert g.formatted_address is None
    assert g.name is None
    assert g.mapbox_id is None


def test_geocode_result_lat_too_high_raises():
    with pytest.raises(ValidationError):
        GeocodeResult(lat=90.001, lng=0.0)


def test_geocode_result_lat_too_low_raises():
    with pytest.raises(ValidationError):
        GeocodeResult(lat=-90.001, lng=0.0)


def test_geocode_result_lng_too_high_raises():
    with pytest.raises(ValidationError):
        GeocodeResult(lat=0.0, lng=180.001)


def test_geocode_result_lng_too_low_raises():
    with pytest.raises(ValidationError):
        GeocodeResult(lat=0.0, lng=-180.001)


def test_geocode_result_boundary_values_ok():
    """Exact boundary values must be accepted (ge=-90 le=90, ge=-180 le=180)."""
    g = GeocodeResult(lat=90.0, lng=180.0)
    assert g.lat == 90.0
    assert g.lng == 180.0
    g2 = GeocodeResult(lat=-90.0, lng=-180.0)
    assert g2.lat == -90.0
    assert g2.lng == -180.0
