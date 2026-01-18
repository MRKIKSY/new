import os
from fastapi import FastAPI, File, UploadFile, Form, HTTPException, Request, Depends
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.sessions import SessionMiddleware
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorGridFSBucket
from bson import ObjectId
from typing import List
from datetime import datetime
import aiofiles
import tempfile
import uvicorn

# ---------- ENV ----------
MONGO_URI = os.environ.get("MONGO_URI", "mongodb://localhost:27017/pwan")
SESSION_KEY = os.environ.get("SESSION_KEY", "devsessionkey")

# ---------- APP ----------
app = FastAPI()

# ---------- SESSION ----------
app.add_middleware(SessionMiddleware, secret_key=SESSION_KEY)

# ---------- CORS ----------
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # adjust for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------- STATIC FILES ----------
app.mount("/", StaticFiles(directory="public", html=True), name="public")

# ---------- DATABASE ----------
client = AsyncIOMotorClient(MONGO_URI)
db = client.get_default_database()
fs_bucket = AsyncIOMotorGridFSBucket(db, bucket_name="uploads")
submissions_collection = db.submissions

# ---------- ADMIN DEPENDENCY ----------
def admin_required(request: Request):
    if not request.session.get("admin"):
        raise HTTPException(status_code=403, detail="Admin access only")

# ---------- ROUTES ----------

@app.post("/submit-poa")
async def submit_poa(
    fullName: str = Form(...),
    email: str = Form(...),
    paymentDate: str = Form(...),
    accountDetails: str = Form(...),
    documents: List[UploadFile] = File(...)
):
    if not documents:
        raise HTTPException(status_code=400, detail="At least one document required")

    files_meta = []
    for doc in documents:
        # Upload to GridFS
        file_id = await fs_bucket.upload_from_stream(
            doc.filename,
            doc.file,
            metadata={"originalName": doc.filename, "contentType": doc.content_type}
        )
        files_meta.append({
            "fileId": str(file_id),
            "filename": doc.filename,
            "contentType": doc.content_type
        })

    submission = {
        "fullName": fullName,
        "email": email,
        "paymentDate": paymentDate,
        "accountDetails": accountDetails,
        "files": files_meta,
        "createdAt": datetime.utcnow()
    }

    result = await submissions_collection.insert_one(submission)
    return {"success": True, "id": str(result.inserted_id)}

# ---------- ADMIN LOGIN ----------
@app.post("/admin/login")
async def admin_login(request: Request):
    request.session["admin"] = True
    return {"success": True, "message": "Logged in as admin"}

@app.post("/admin/logout")
async def admin_logout(request: Request, admin=Depends(admin_required)):
    request.session.clear()
    return {"success": True, "message": "Logged out"}

# ---------- LIST SUBMISSIONS ----------
@app.get("/admin/submissions")
async def list_submissions(admin=Depends(admin_required)):
    submissions = []
    cursor = submissions_collection.find().sort("createdAt", -1)
    async for doc in cursor:
        doc["_id"] = str(doc["_id"])
        for f in doc.get("files", []):
            f["fileId"] = str(f["fileId"])
        submissions.append(doc)
    return submissions

# ---------- DOWNLOAD FILE ----------
@app.get("/admin/file/{file_id}")
async def download_file(file_id: str, admin=Depends(admin_required)):
    try:
        oid = ObjectId(file_id)
        file_info = await db["uploads.files"].find_one({"_id": oid})
        if not file_info:
            raise HTTPException(status_code=404, detail="File not found")

        # Stream to temporary file
        with tempfile.NamedTemporaryFile(delete=False) as tmp_file:
            async for chunk in fs_bucket.open_download_stream(oid):
                tmp_file.write(chunk)
            tmp_path = tmp_file.name

        return FileResponse(
            tmp_path,
            media_type=file_info.get("metadata", {}).get("contentType", "application/octet-stream"),
            filename=file_info.get("metadata", {}).get("originalName", file_info["filename"])
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

# ---------- START SERVER ----------
if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 8000)),
        reload=True
    )
