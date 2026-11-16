import "./commands/groups.ts";
import "./commands/members.ts";
import "./commands/labels.ts";
import "./commands/tracks.ts";
import "./commands/inspect.ts";
import "./commands/chat.ts";
import "./gui/index.ts";
import { startChat } from "./chat-format.ts";
import { startPaper } from "./paper.ts";

startPaper();
startChat();
