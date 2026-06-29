from pipeline.geo import haversine_m


def test_haversine_zero_distance():
    assert haversine_m(35.0, 139.0, 35.0, 139.0) == 0.0


def test_haversine_known_short_distance():
    # ~111 m per 0.001° latitude near Tokyo
    d = haversine_m(35.000, 139.000, 35.001, 139.000)
    assert 100 < d < 125
