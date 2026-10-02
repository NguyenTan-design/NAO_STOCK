const OWNER = "NguyenTan-design";

const REPO = "NAO_STOCK";

const BRANCH = "main";

const FILE = "data.json";

const GITHUB_API =
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE}`;

const LOG_MAP_FILE = "log_map.json";

const LOGS_DIR = "logs";

const GITHUB_GIT_API =
    `https://api.github.com/repos/${OWNER}/${REPO}/git`;

const GITHUB_CONTENTS_API =
    `https://api.github.com/repos/${OWNER}/${REPO}/contents`;


// ============================================================
// CUSTOM ERROR
// ============================================================

class HttpError extends Error {
    /**
     * @param {string} message
     * @param {number} status
     */
    constructor(message, status) {
        super(message);
        this.name = "HttpError";
        this.status = status;
    }
}


// ============================================================
// MAIN
// ============================================================

export default {
    async fetch(request, env) {
        const origin = request.headers.get("Origin") || "";
        const allowedOrigin = (env.ALLOWED_ORIGIN || "").trim();

        if (!allowedOrigin) {
            return jsonResponse(
                {
                    success: false,
                    message: "ALLOWED_ORIGIN is not configured."
                },
                500,
                origin
            );
        }

        if (request.method === "OPTIONS") {
            if (!isAllowedOrigin(origin, allowedOrigin)) {
                return new Response("Forbidden", { status: 403 });
            }

            return new Response(
                null,
                {
                    status: 204,
                    headers: corsHeaders(origin)
                }
            );
        }

        if (!isAllowedOrigin(origin, allowedOrigin)) {
            return jsonResponse(
                {
                    success: false,
                    message: "Origin not allowed."
                },
                403,
                origin
            );
        }

        const url = new URL(request.url);
        const path = url.pathname;

        const allowedPaths = [
            "/add-issue",
            "/update-issue",
            "/delete-issue",
            "/get-log",
            "/save-log"
        ];

        if (!allowedPaths.includes(path)) {
            return jsonResponse(
                {
                    success: false,
                    message: "Endpoint not found."
                },
                404,
                origin
            );
        }

        if (request.method !== "POST") {
            return jsonResponse(
                {
                    success: false,
                    message: "Only POST method is allowed."
                },
                405,
                origin
            );
        }

        if (!env.GITHUB_TOKEN) {
            return jsonResponse(
                {
                    success: false,
                    message: "GITHUB_TOKEN is not configured."
                },
                500,
                origin
            );
        }

        let body;

        try {
            body = await request.json();
        }
        catch (error) {
            return jsonResponse(
                {
                    success: false,
                    message: "Invalid JSON request."
                },
                400,
                origin
            );
        }

        if (path === "/update-issue") {
            return handleUpdateIssue(body, env, origin);
        }

        if (path === "/delete-issue") {
            return handleDeleteIssue(body, env, origin);
        }

        if (path === "/get-log") {
            return handleGetLog(body, env, origin);
        }

        if (path === "/save-log") {
            return handleSaveLog(body, env, origin);
        }

        return handleAddIssue(body, env, origin);
    }
};


// ============================================================
// HANDLER: ADD ISSUE
// ============================================================

async function handleAddIssue(body, env, origin) {
    const validation = validateRecord(body, null);

    if (!validation.valid) {
        return jsonResponse(
            {
                success: false,
                message: validation.message
            },
            400,
            origin
        );
    }

    const record = validation.record;

    try {
        const token = env.GITHUB_TOKEN;

        const dataRes = await githubRequest(
            "GET",
            `${GITHUB_API}?ref=${encodeURIComponent(BRANCH)}`,
            token
        );

        if (!dataRes.ok) {
            throw new Error(
                await githubErrorMessage(
                    dataRes,
                    "Unable to read data.json."
                )
            );
        }

        const dataFile = await dataRes.json();

        const currentData = JSON.parse(
            base64ToUtf8(dataFile.content)
        );

        if (!Array.isArray(currentData)) {
            throw new Error("data.json must contain a JSON array.");
        }

        const logMap = await readLogMap(token);
        const nextNum = await getNextLogNumber(token);

        /* File log dùng đuôi .html để hỗ trợ ảnh */

        const logFileName = `log_${nextNum}.html`;
        const logPath = `${LOGS_DIR}/${logFileName}`;

        currentData.push(record);

        logMap[recordKey(record)] = logFileName;

        await commitMultipleFiles(
            token,
            "Add new record + log file",
            [
                {
                    path: FILE,
                    content: JSON.stringify(currentData, null, 4)
                },
                {
                    path: LOG_MAP_FILE,
                    content: JSON.stringify(logMap, null, 4)
                },
                {
                    path: logPath,
                    content: ""
                }
            ]
        );

        return jsonResponse(
            {
                success: true,
                message: "Record added successfully.",
                record: record,
                logFile: logFileName
            },
            200,
            origin
        );
    }
    catch (error) {
        console.error(error);

        const status =
            error instanceof HttpError ? error.status : 500;

        return jsonResponse(
            {
                success: false,
                message: error.message || "Failed to update GitHub."
            },
            status,
            origin
        );
    }
}


// ============================================================
// HANDLER: UPDATE ISSUE
// ============================================================

async function handleUpdateIssue(body, env, origin) {
    if (
        !body ||
        typeof body !== "object" ||
        !body.original ||
        typeof body.original !== "object" ||
        !body.updated ||
        typeof body.updated !== "object"
    ) {
        return jsonResponse(
            {
                success: false,
                message: "Request must contain 'original' and 'updated'."
            },
            400,
            origin
        );
    }

    const original = body.original;

    const validation = validateRecord(body.updated, original);

    if (!validation.valid) {
        return jsonResponse(
            {
                success: false,
                message: validation.message
            },
            400,
            origin
        );
    }

    const updated = validation.record;

    try {
        const token = env.GITHUB_TOKEN;

        const dataRes = await githubRequest(
            "GET",
            `${GITHUB_API}?ref=${encodeURIComponent(BRANCH)}`,
            token
        );

        if (!dataRes.ok) {
            throw new Error(
                await githubErrorMessage(
                    dataRes,
                    "Unable to read data.json."
                )
            );
        }

        const dataFile = await dataRes.json();

        const currentData = JSON.parse(
            base64ToUtf8(dataFile.content)
        );

        const index = findRecordIndex(currentData, original);

        if (index === -1) {
            throw new HttpError(
                "Record not found. It may have been changed or deleted by someone else — please reload the page.",
                404
            );
        }

        const existing = currentData[index];

        const merged = Object.assign({}, existing, {
            DATE: updated.DATE,
            STATUS: updated.STATUS,
            DETAIL: updated.DETAIL
        });

        currentData[index] = merged;

        const oldKey = recordKey(original);
        const newKey = recordKey(updated);

        const logMap = await readLogMap(token);
        const logFileName = logMap[oldKey] || null;

        /**
         * @type {Array<
         *     { path: string, content: string, delete?: false } |
         *     { path: string, delete: true, content?: undefined }
         * >}
         */
        const files = [
            {
                path: FILE,
                content: JSON.stringify(currentData, null, 4)
            }
        ];

        if (logFileName && oldKey !== newKey) {
            logMap[newKey] = logFileName;
            delete logMap[oldKey];

            files.push({
                path: LOG_MAP_FILE,
                content: JSON.stringify(logMap, null, 4)
            });
        }

        await commitMultipleFiles(
            token,
            "Update record",
            files
        );

        return jsonResponse(
            {
                success: true,
                message: "Record updated successfully.",
                record: merged,
                logFile: logFileName
            },
            200,
            origin
        );
    }
    catch (error) {
        console.error(error);

        const status =
            error instanceof HttpError ? error.status : 500;

        return jsonResponse(
            {
                success: false,
                message: error.message || "Failed to update GitHub."
            },
            status,
            origin
        );
    }
}


// ============================================================
// HANDLER: DELETE ISSUE
// ============================================================

async function handleDeleteIssue(body, env, origin) {
    if (
        !body ||
        typeof body !== "object" ||
        !body.record ||
        typeof body.record !== "object"
    ) {
        return jsonResponse(
            {
                success: false,
                message: "Request must contain 'record'."
            },
            400,
            origin
        );
    }

    const record = body.record;

    if (
        !String(record.DATE || "").trim() ||
        !String(record.STATUS || "").trim()
    ) {
        return jsonResponse(
            {
                success: false,
                message: "'record' must include at least DATE and STATUS."
            },
            400,
            origin
        );
    }

    if (!env.DELETE_PASSWORD) {
        return jsonResponse(
            {
                success: false,
                message: "DELETE_PASSWORD is not configured."
            },
            500,
            origin
        );
    }

    const password = String(body.password || "");

    if (!timingSafeEqual(password, env.DELETE_PASSWORD)) {
        return jsonResponse(
            {
                success: false,
                message: "Sai password."
            },
            403,
            origin
        );
    }

    try {
        const token = env.GITHUB_TOKEN;

        const dataRes = await githubRequest(
            "GET",
            `${GITHUB_API}?ref=${encodeURIComponent(BRANCH)}`,
            token
        );

        if (!dataRes.ok) {
            throw new Error(
                await githubErrorMessage(
                    dataRes,
                    "Unable to read data.json."
                )
            );
        }

        const dataFile = await dataRes.json();

        const currentData = JSON.parse(
            base64ToUtf8(dataFile.content)
        );

        const index = findRecordIndex(currentData, record);

        if (index === -1) {
            throw new HttpError(
                "Record not found. It may have been changed or deleted by someone else — please reload the page.",
                404
            );
        }

        const removed = currentData.splice(index, 1)[0];

        const logMap = await readLogMap(token);
        const key = recordKey(record);
        const logFileName = logMap[key] || null;

        /**
         * @type {Array<
         *     { path: string, content: string, delete?: false } |
         *     { path: string, delete: true, content?: undefined }
         * >}
         */
        const files = [
            {
                path: FILE,
                content: JSON.stringify(currentData, null, 4)
            }
        ];

        if (logFileName) {
            delete logMap[key];

            files.push({
                path: LOG_MAP_FILE,
                content: JSON.stringify(logMap, null, 4)
            });

            files.push({
                path: `${LOGS_DIR}/${logFileName}`,
                delete: true
            });
        }

        await commitMultipleFiles(
            token,
            "Delete record + log file",
            files
        );

        return jsonResponse(
            {
                success: true,
                message: "Record deleted successfully.",
                record: removed
            },
            200,
            origin
        );
    }
    catch (error) {
        console.error(error);

        const status =
            error instanceof HttpError ? error.status : 500;

        return jsonResponse(
            {
                success: false,
                message: error.message || "Failed to update GitHub."
            },
            status,
            origin
        );
    }
}


// ============================================================
// HANDLER: GET LOG
// ============================================================

async function handleGetLog(body, env, origin) {
    if (!body || typeof body !== "object" || !body.record) {
        return jsonResponse(
            {
                success: false,
                message: "Request must contain 'record'."
            },
            400,
            origin
        );
    }

    try {
        const token = env.GITHUB_TOKEN;
        const logMap = await readLogMap(token);
        const fileName = logMap[recordKey(body.record)];

        if (!fileName) {
            /* Record chưa có file log — trả về rỗng,
               user có thể Edit để tạo mới. */
            return jsonResponse(
                {
                    success: true,
                    content: "",
                    fileName: null
                },
                200,
                origin
            );
        }

        const content = await readLogFile(
            token,
            `${LOGS_DIR}/${fileName}`
        );

        return jsonResponse(
            {
                success: true,
                content: content || "",
                fileName: fileName
            },
            200,
            origin
        );
    }
    catch (error) {
        console.error(error);

        return jsonResponse(
            {
                success: false,
                message: error.message || "Failed to read log."
            },
            500,
            origin
        );
    }
}


// ============================================================
// HANDLER: SAVE LOG
//
// Nếu record chưa có file log (record cũ, hoặc log_map bị
// mất), tự tạo file log mới và ghi nội dung vào đó.
// ============================================================

async function handleSaveLog(body, env, origin) {
    if (!body || typeof body !== "object" || !body.record) {
        return jsonResponse(
            {
                success: false,
                message: "Request must contain 'record'."
            },
            400,
            origin
        );
    }

    if (typeof body.content !== "string") {
        return jsonResponse(
            {
                success: false,
                message: "Request must contain 'content' string."
            },
            400,
            origin
        );
    }

    try {
        const token = env.GITHUB_TOKEN;
        const logMap = await readLogMap(token);
        const key = recordKey(body.record);

        let fileName = logMap[key];

        // ----------------------------------------------------
        // Chưa có file log → tạo file mới và ghi nội dung
        // ----------------------------------------------------

        if (!fileName) {
            const nextNum = await getNextLogNumber(token);

            fileName = `log_${nextNum}.html`;
            logMap[key] = fileName;

            await commitMultipleFiles(
                token,
                "Create log file for existing record",
                [
                    {
                        path: `${LOGS_DIR}/${fileName}`,
                        content: body.content
                    },
                    {
                        path: LOG_MAP_FILE,
                        content: JSON.stringify(logMap, null, 4)
                    }
                ]
            );

            return jsonResponse(
                {
                    success: true,
                    message: "Log file created and saved.",
                    fileName: fileName
                },
                200,
                origin
            );
        }

        // ----------------------------------------------------
        // Đã có file log → chỉ cập nhật nội dung
        // ----------------------------------------------------

        await commitMultipleFiles(
            token,
            "Update log content",
            [
                {
                    path: `${LOGS_DIR}/${fileName}`,
                    content: body.content
                }
            ]
        );

        return jsonResponse(
            {
                success: true,
                message: "Log saved.",
                fileName: fileName
            },
            200,
            origin
        );
    }
    catch (error) {
        console.error(error);

        return jsonResponse(
            {
                success: false,
                message: error.message || "Failed to save log."
            },
            500,
            origin
        );
    }
}


// ============================================================
// CORS
// ============================================================

function isAllowedOrigin(origin, allowedOrigin) {
    return origin === allowedOrigin;
}

function corsHeaders(origin) {
    return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400"
    };
}

function jsonResponse(data, status, origin) {
    const headers = {
        "Content-Type": "application/json; charset=UTF-8",
        "Cache-Control": "no-store"
    };

    if (origin) {
        headers["Access-Control-Allow-Origin"] = origin;
    }

    return new Response(
        JSON.stringify(data),
        {
            status,
            headers
        }
    );
}


// ============================================================
// VALIDATE RECORD
// ============================================================

function validateRecord(body, original) {
    if (!body || typeof body !== "object") {
        return {
            valid: false,
            message: "Invalid request data."
        };
    }

    const date = String(body.DATE || "").trim();

    if (!isValidDate(date)) {
        return {
            valid: false,
            message: "DATE must be a valid date in MM/DD/YY format."
        };
    }

    const rawStatus = String(body.STATUS || "").trim();

    let status = normalizeStatus(rawStatus);

    if (
        !status &&
        original &&
        rawStatus &&
        String(original.STATUS || "").trim() === rawStatus
    ) {
        status = rawStatus;
    }

    if (!status) {
        return {
            valid: false,
            message: "STATUS must be PART IN or PART OUT."
        };
    }

    const detail = String(body.DETAIL || "").trim();

    if (!detail) {
        return {
            valid: false,
            message: "DETAIL is required."
        };
    }

    return {
        valid: true,
        record: {
            DATE: date,
            STATUS: status,
            DETAIL: detail,
            LOG: ""
        }
    };
}


// ============================================================
// DATE VALIDATION
// ============================================================

function isValidDate(value) {
    const match = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(value);

    if (!match) {
        return false;
    }

    const month = Number(match[1]);
    const day = Number(match[2]);
    const year = 2000 + Number(match[3]);

    if (month < 1 || month > 12 || day < 1) {
        return false;
    }

    const date = new Date(year, month - 1, day);

    return (
        date.getFullYear() === year &&
        date.getMonth() === month - 1 &&
        date.getDate() === day
    );
}


// ============================================================
// STATUS
// ============================================================

function normalizeStatus(value) {
    const status = String(value || "").trim().toUpperCase();

    const map = {
        "PART IN": "PART IN",
        "PART OUT": "PART OUT"
    };

    return map[status] || null;
}


// ============================================================
// GIT DATA API: COMMIT MULTIPLE FILES IN ONE COMMIT
// ============================================================

/**
 * @param {string} token
 * @param {string} message
 * @param {Array<
 *     { path: string, content: string, delete?: false } |
 *     { path: string, delete: true, content?: undefined }
 * >} files
 */
async function commitMultipleFiles(token, message, files) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            // 1. Read current branch ref

            const refRes = await githubRequest(
                "GET",
                `${GITHUB_GIT_API}/ref/heads/${BRANCH}`,
                token
            );

            if (!refRes.ok) {
                throw new Error(
                    await githubErrorMessage(
                        refRes,
                        "Cannot read branch ref."
                    )
                );
            }

            const refData = await refRes.json();
            const baseCommitSha = refData.object.sha;

            // 2. Read base commit to get its tree

            const commitRes = await githubRequest(
                "GET",
                `${GITHUB_GIT_API}/commits/${baseCommitSha}`,
                token
            );

            if (!commitRes.ok) {
                throw new Error(
                    await githubErrorMessage(
                        commitRes,
                        "Cannot read base commit."
                    )
                );
            }

            const baseCommit = await commitRes.json();
            const baseTreeSha = baseCommit.tree.sha;

            // 3. Create blobs for each file

            /** @type {Array<{ path: string, mode: string, type: string, sha: string | null }>} */
            const treeEntries = [];

            for (const file of files) {
                if (file.delete) {
                    treeEntries.push({
                        path: file.path,
                        mode: "100644",
                        type: "blob",
                        sha: null
                    });
                    continue;
                }

                const blobRes = await githubRequest(
                    "POST",
                    `${GITHUB_GIT_API}/blobs`,
                    token,
                    {
                        content: utf8ToBase64(file.content),
                        encoding: "base64"
                    }
                );

                if (!blobRes.ok) {
                    throw new Error(
                        await githubErrorMessage(
                            blobRes,
                            `Cannot create blob for ${file.path}.`
                        )
                    );
                }

                const blob = await blobRes.json();

                treeEntries.push({
                    path: file.path,
                    mode: "100644",
                    type: "blob",
                    sha: blob.sha
                });
            }

            // 4. Create new tree

            const treeRes = await githubRequest(
                "POST",
                `${GITHUB_GIT_API}/trees`,
                token,
                {
                    base_tree: baseTreeSha,
                    tree: treeEntries
                }
            );

            if (!treeRes.ok) {
                throw new Error(
                    await githubErrorMessage(
                        treeRes,
                        "Cannot create tree."
                    )
                );
            }

            const newTree = await treeRes.json();

            // 5. Create commit

            const newCommitRes = await githubRequest(
                "POST",
                `${GITHUB_GIT_API}/commits`,
                token,
                {
                    message: message,
                    tree: newTree.sha,
                    parents: [baseCommitSha]
                }
            );

            if (!newCommitRes.ok) {
                throw new Error(
                    await githubErrorMessage(
                        newCommitRes,
                        "Cannot create commit."
                    )
                );
            }

            const newCommit = await newCommitRes.json();

            // 6. Update branch ref

            const updateRefRes = await githubRequest(
                "PATCH",
                `${GITHUB_GIT_API}/refs/heads/${BRANCH}`,
                token,
                {
                    sha: newCommit.sha,
                    force: false
                }
            );

            if (!updateRefRes.ok) {
                if (attempt === 0) {
                    continue;
                }

                throw new Error(
                    await githubErrorMessage(
                        updateRefRes,
                        "Cannot update branch ref."
                    )
                );
            }

            return {
                commitSha: newCommit.sha
            };
        }
        catch (error) {
            if (attempt === 0) {
                continue;
            }
            throw error;
        }
    }

    throw new Error("Unable to commit after retry.");
}


// ============================================================
// READ / WRITE log_map.json AND LOG FILES
// ============================================================

async function readLogMap(token) {
    const res = await githubRequest(
        "GET",
        `${GITHUB_CONTENTS_API}/${LOG_MAP_FILE}?ref=${encodeURIComponent(BRANCH)}`,
        token
    );

    if (res.status === 404) {
        return {};
    }

    if (!res.ok) {
        throw new Error(
            await githubErrorMessage(
                res,
                "Cannot read log_map.json."
            )
        );
    }

    const data = await res.json();

    try {
        const parsed = JSON.parse(
            base64ToUtf8(data.content)
        );

        if (
            parsed &&
            typeof parsed === "object" &&
            !Array.isArray(parsed)
        ) {
            return parsed;
        }

        return {};
    }
    catch (error) {
        return {};
    }
}


function recordKey(record) {
    return [
        normalizeDateForCompare(record.DATE),
        String(record.STATUS || "").trim().toUpperCase(),
        String(record.DETAIL || "").trim()
    ].join("||");
}


async function readLogFile(token, path) {
    const res = await githubRequest(
        "GET",
        `${GITHUB_CONTENTS_API}/${path}?ref=${encodeURIComponent(BRANCH)}`,
        token
    );

    if (res.status === 404) {
        return null;
    }

    if (!res.ok) {
        throw new Error(
            await githubErrorMessage(
                res,
                "Cannot read log file."
            )
        );
    }

    const data = await res.json();

    return base64ToUtf8(data.content);
}


async function getNextLogNumber(token) {
    const res = await githubRequest(
        "GET",
        `${GITHUB_CONTENTS_API}/${LOGS_DIR}?ref=${encodeURIComponent(BRANCH)}`,
        token
    );

    if (res.status === 404) {
        return 1;
    }

    if (!res.ok) {
        throw new Error(
            await githubErrorMessage(
                res,
                "Cannot list logs."
            )
        );
    }

    const items = await res.json();

    let max = 0;

    if (Array.isArray(items)) {
        for (const item of items) {
            /* Chấp nhận cả log_N.txt (file cũ) và log_N.html (file mới)
               để số thứ tự không bị trùng */

            const m = /^log_(\d+)\.(txt|html)$/.exec(item.name);

            if (m) {
                max = Math.max(max, Number(m[1]));
            }
        }
    }

    return max + 1;
}


// ============================================================
// FIND RECORD
//
// NOTE: Chỉ so sánh DATE + STATUS + DETAIL.
// Trường LOG không tham gia vào việc tìm record vì:
// - Trong data.json, LOG luôn là chuỗi rỗng "" (file log
//   được lưu riêng trong logs/ và map qua log_map.json).
// - Nếu so sánh LOG, có thể gây lỗi "Record not found" khi
//   Edit/Delete do payload frontend gửi lên và dữ liệu trong
//   data.json không khớp nhau về trường này.
// ============================================================

function normalizeDateForCompare(value) {
    const text = String(value || "").trim();

    if (/^\d{2}\/\d{2}\/\d{2}$/.test(text)) {
        return text;
    }

    const date = new Date(text);

    if (isNaN(date.getTime())) {
        return text;
    }

    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const year = String(date.getFullYear()).slice(-2);

    return `${month}/${day}/${year}`;
}


function sameText(a, b) {
    return (
        String(a || "").trim() ===
        String(b || "").trim()
    );
}


function findRecordIndex(data, original) {
    const wantedDate = normalizeDateForCompare(original.DATE);

    return data.findIndex(function (item) {
        return (
            item &&
            normalizeDateForCompare(item.DATE) === wantedDate &&
            sameText(
                String(item.STATUS || "").toUpperCase(),
                String(original.STATUS || "").toUpperCase()
            ) &&
            sameText(
                item.DETAIL,
                original.DETAIL
            )
        );
    });
}


// ============================================================
// GITHUB REQUEST
// ============================================================

async function githubRequest(method, url, token, body = null) {
    const options = {
        method,
        headers: {
            "Authorization": `Bearer ${token}`,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "NAO-Stock-Backend"
        }
    };

    if (body !== null) {
        options.headers["Content-Type"] = "application/json";
        options.body = JSON.stringify(body);
    }

    return fetch(url, options);
}


// ============================================================
// GITHUB ERROR
// ============================================================

async function githubErrorMessage(response, defaultMessage) {
    try {
        const data = await response.json();

        if (data.message) {
            return `${defaultMessage} GitHub: ${data.message}`;
        }
    }
    catch (error) {
        // Ignore JSON parsing error
    }

    return `${defaultMessage} HTTP ${response.status}.`;
}


// ============================================================
// TIMING-SAFE STRING COMPARE
// ============================================================

function timingSafeEqual(a, b) {
    const bufA = new TextEncoder().encode(a);
    const bufB = new TextEncoder().encode(b);

    if (bufA.length !== bufB.length) {
        let dummy = 0;

        for (let i = 0; i < bufA.length; i++) {
            dummy |= bufA[i] ^ bufA[i];
        }

        return false;
    }

    let diff = 0;

    for (let i = 0; i < bufA.length; i++) {
        diff |= bufA[i] ^ bufB[i];
    }

    return diff === 0;
}


// ============================================================
// UTF-8 → BADSE64
// ============================================================

function utf8ToBase64(value) {
    const bytes = new TextEncoder().encode(value);

    let binary = "";

    const chunkSize = 0x8000;

    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(
            ...bytes.subarray(i, i + chunkSize)
        );
    }

    return btoa(binary);
}


// ============================================================
// BASE64 → UTF-8
// ============================================================

function base64ToUtf8(value) {
    const binary = atob(value.replace(/\s/g, ""));

    const bytes = Uint8Array.from(
        binary,
        character => character.charCodeAt(0)
    );

    return new TextDecoder().decode(bytes);
}