Logging Rules
Structured Logging

Không log plain string.

Không:

console.log("User login");

Nên:

logger.info({
  event: "user_login",
  userId
});
Sensitive Information

Không log:

password
token
full phone number
payment data
Request Trace

Mỗi request phải có:

requestId

RequestId phải xuất hiện xuyên suốt:

HTTP Request
 ↓
Service
 ↓
Database
 ↓
Queue

để debug.