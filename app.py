from flask import Flask, render_template
from flask_socketio import SocketIO, emit
from modules import get_available_modules, get_initial_pipeline

app = Flask(__name__)
app.config["SECRET_KEY"] = "cosmosis-gui-v2-secret"
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


if __name__ == "__main__":
    socketio.run(app, debug=True, port=5000)
