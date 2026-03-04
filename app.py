import yaml
from flask import Flask, render_template
from flask_cors import CORS
from flask_socketio import SocketIO, emit
from module_library import parse_yaml_files
from modules import get_available_modules, get_initial_pipeline

app = Flask(__name__)
app.config["SECRET_KEY"] = "cosmosis-gui-v2-secret"
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*")


@app.route("/")
def index():
    return render_template("index.html")


@socketio.on("connect")
def handle_connect():
    emit("available_modules", get_available_modules())
    emit("pipeline_update", get_initial_pipeline())


@socketio.on("get_modules")
def handle_get_modules():
    emit("available_modules", get_available_modules())


@socketio.on("get_pipeline")
def handle_get_pipeline():
    emit("pipeline_update", get_initial_pipeline())


@socketio.on("scan_library")
def handle_scan_library(data):
    """Receive a list of {path, content} dicts from the browser, parse them,
    and emit the resulting module list back as 'available_modules'."""
    try:
        file_list = data if isinstance(data, list) else []
        modules = parse_yaml_files(file_list)
        emit("available_modules", modules)
    except (ValueError, TypeError, yaml.YAMLError) as exc:
        emit("scan_error", {"message": str(exc)})


if __name__ == "__main__":
    socketio.run(app, debug=True, port=5000)
