from app.cookie_jar import load_cookie_dict


def test_load_cookie_dict_keeps_values_with_equals(tmp_path):
    cookie_file = tmp_path / "cookies.txt"
    cookie_file.write_text(
        "# Netscape HTTP Cookie File\n"
        ".example.test\tTRUE\t/\tTRUE\t2000000000\ttoken\ta=b=c\n",
        encoding="utf-8",
    )

    assert load_cookie_dict(str(cookie_file)) == {"token": "a=b=c"}
