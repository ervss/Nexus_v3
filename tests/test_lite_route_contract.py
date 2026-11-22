from app.lite_app import app


def test_lite_routes_do_not_repeat_resource_prefixes():
    paths = {route.path for route in app.routes}
    assert {
        "/api/v1/mega/add",
        "/mega/add",
        "/api/v1/source-boards",
        "/api/source-boards",
        "/api/v1/import/bulk",
    } <= paths
    assert not {
        "/api/v1/mega/mega/add",
        "/mega/mega/add",
        "/source-boards/source-boards",
    } & paths


def test_lite_health_routes_and_openapi_ids_are_available_and_unique():
    paths = {route.path for route in app.routes}
    assert {"/api/extractors/health", "/api/v1/extractors/health"} <= paths

    schema = app.openapi()
    operation_ids = [
        operation["operationId"]
        for methods in schema["paths"].values()
        for operation in methods.values()
        if isinstance(operation, dict) and "operationId" in operation
    ]
    assert len(operation_ids) == len(set(operation_ids))
