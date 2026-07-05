from pipeline.geo import centroid, haversine_m


def test_haversine_zero_distance():
    assert haversine_m(35.0, 139.0, 35.0, 139.0) == 0.0


def test_haversine_known_short_distance():
    # ~111 m per 0.001° latitude near Tokyo
    d = haversine_m(35.000, 139.000, 35.001, 139.000)
    assert 100 < d < 125


def test_haversine_near_antipodal_no_crash():
    # Near-antipodal coords can produce h slightly > 1.0 due to floating-point rounding;
    # the min(1.0, h) clamp must prevent a math domain error in asin(sqrt(h)).
    d = haversine_m(90.0, 0.0, -89.0, 180.0)
    assert isinstance(d, float)


class _P:
    def __init__(self, lat, lng): self.lat, self.lng = lat, lng


def test_centroid_mean_of_coord_bearing():
    assert centroid([_P(0.0, 0.0), _P(2.0, 4.0)]) == (1.0, 2.0)


def test_centroid_ignores_no_coord_and_none_when_empty():
    assert centroid([_P(10.0, 20.0), _P(None, None)]) == (10.0, 20.0)
    assert centroid([_P(None, None)]) is None
    assert centroid([]) is None
