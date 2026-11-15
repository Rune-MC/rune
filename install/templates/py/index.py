from rune import broadcast, command, on


@on("PlayerJoinEvent")
def welcome(event):
    broadcast(f"Welcome, {event['player']['name']}!")


@command("python-hello", description="Say hello from Python")
def hello(context):
    broadcast("Hello from Python!")
