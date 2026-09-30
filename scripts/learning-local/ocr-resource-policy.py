"""Learning OCR admission policy. Standard library only; no GPU/model calls."""
import hashlib
import json
import time

DEFAULT_POLICY = {
    "version": "learning-ocr-resource-v1",
    "startup_free_mib": 16384,
    "pause_free_mib": 2048,
    "resume_free_mib": 3072,
    "resume_stable_seconds": 10,
    "emergency_free_mib": 1024,
    "emergency_seconds": 10,
    "max_owned_mib": 16384,
    "owned_over_limit_seconds": 10,
    "snapshot_max_age_seconds": 20,
    "retry_after_seconds": 10,
}

def validate_policy(value):
    if set(value) != set(DEFAULT_POLICY) or value["version"] != DEFAULT_POLICY["version"]:
        raise ValueError("Unsupported OCR resource policy")
    for key, number in value.items():
        if key != "version" and (type(number) is not int or number <= 0):
            raise ValueError("Invalid resource policy: " + key)
    if not value["emergency_free_mib"] < value["pause_free_mib"] < value["resume_free_mib"] < value["startup_free_mib"]:
        raise ValueError("Invalid resource watermarks")
    return dict(value)

def service_epoch(root, output):
    # Every instance directory is created once. session-1 alone is not unique.
    return hashlib.sha256((str(root) + "\0" + str(output)).encode()).hexdigest()

class ResourcePolicy:
    def __init__(self, config):
        self.config = validate_policy(config)
        self.paused = False
        self.recovering_since = None
        self.emergency_since = None
        self.over_limit_since = None
        self.last_observation = None

    def observe(self, free_mib, owned_mib, now):
        if any(type(x) is not int or x < 0 for x in (free_mib, owned_mib)):
            raise ValueError("Invalid GPU resource sample")
        p = self.config
        if self.last_observation is not None and not 0 < now - self.last_observation <= p["snapshot_max_age_seconds"]:
            self.recovering_since = self.emergency_since = self.over_limit_since = None
        self.last_observation = now
        self.emergency_since = (now if self.emergency_since is None else self.emergency_since) if free_mib < p["emergency_free_mib"] else None
        self.over_limit_since = (now if self.over_limit_since is None else self.over_limit_since) if owned_mib > p["max_owned_mib"] else None
        hard_stop = None
        if self.emergency_since is not None and now - self.emergency_since >= p["emergency_seconds"]:
            hard_stop = "sustained_gpu_emergency"
        if self.over_limit_since is not None and now - self.over_limit_since >= p["owned_over_limit_seconds"]:
            hard_stop = "sustained_owned_gpu_limit"
        low = free_mib < p["pause_free_mib"] or owned_mib > p["max_owned_mib"]
        if low:
            self.paused = True
            self.recovering_since = None
        elif self.paused:
            if free_mib >= p["resume_free_mib"] and owned_mib <= p["max_owned_mib"]:
                if self.recovering_since is None:
                    self.recovering_since = now
                if now - self.recovering_since >= p["resume_stable_seconds"]:
                    self.paused = False
                    self.recovering_since = None
            else:
                self.recovering_since = None
        return {"accepting": not self.paused and hard_stop is None,
                "reason": "resource_wait" if self.paused or hard_stop else None,
                "hard_stop": hard_stop, "free_mib": free_mib, "owned_mib": owned_mib}

def read_admission(output, epoch, config, now=None):
    """Stale/missing samples cannot authorize new work."""
    now = time.time() if now is None else now
    closed = {"accepting": False, "reason": "resource_wait"}
    try:
        state = json.loads((output / "resource-state.json").read_text())
        age = now - state["at"]
        if state["service_epoch"] != epoch or not 0 <= age <= config["snapshot_max_age_seconds"]:
            return closed
        if state.get("hard_stop"):
            return closed
        if state.get("draining"):
            return {"accepting": False, "reason": "session_expired"}
        return {"accepting": state.get("accepting") is True,
                "reason": state.get("reason") or (None if state.get("accepting") is True else "resource_wait")}
    except (OSError, ValueError, KeyError, TypeError):
        return closed

def unaccepted(request, instance, epoch, reason, retry_after_seconds):
    """Call only before creating/accepting a job or consuming inference units."""
    page_range = request.page_range
    pages = list(range(page_range.start, page_range.end + 1)) if page_range and 1 <= page_range.start <= page_range.end and page_range.end - page_range.start < 30 else None
    return {"request_id": request.request_id, "document_id": request.document_id,
            "sha256": request.sha256,
            "pages": pages,
            "status": "not_accepted", "accepted": False, "reason": reason,
            "instance": instance, "service_epoch": epoch,
            "retry_after_seconds": retry_after_seconds}


def budget_admission(root, caps, required_pages=1):
    """Read-only pre-admission check; actual consumption remains reserve()."""
    closed = {"accepting": False, "reason": "resource_wait"}
    try:
        used = json.loads((root / "evidence/budget.json").read_text())
        if type(required_pages) is not int or required_pages < 1 or required_pages > 30:
            return closed
        for kind, required in (("pages", required_pages), ("http", 1)):
            cap = caps[kind]
            if type(used[kind]) is not int or used[kind] < 0:
                return closed
            if cap is not None:
                if type(cap) is not int or cap <= 0:
                    return closed
                if used[kind] + required > cap:
                    return {"accepting": False, "reason": "budget_exhausted"}
        return {"accepting": True, "reason": None}
    except (OSError, ValueError, KeyError, TypeError):
        return closed
