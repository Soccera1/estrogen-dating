#!/usr/bin/env python3
"""Interactively configure an instance using only the Python 3 standard library."""
import copy
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import urlsplit


OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"


def configured(value):
    return isinstance(value, str) and bool(value) and not re.search(r"YOUR_|PLACEHOLDER", value, re.I)


def label(value):
    return bool(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", value))


def hostname(value):
    return len(value) <= 253 and "." in value and all(map(label, value.split(".")))


def issuer_url(value):
    try:
        url = urlsplit(value)
        # Accessing port also validates malformed/out-of-range ports.
        _ = url.port
        return (url.scheme == "https" and bool(url.hostname)
                and not any((url.username, url.password, url.query, url.fragment))
                and not re.search(r"\s|\\", value))
    except ValueError:
        return False


def validate_structure(config):
    """Retain the deployment resource restrictions when editing existing files.

    Prompted instance values are validated by configure_deployment. Deployment
    itself still runs the authoritative billing/account checks before publishing.
    """
    def require(condition, message):
        if not condition:
            raise ValueError(f"Deployment refused: {message}")

    require(not (config.keys() - {"accountId", "billingMode", "worker"}), "unexpected deployment resources")
    worker = config["worker"]
    require(not (worker.keys() - {"name", "compatibilityDate", "assets", "domains", "workersDev", "previewUrls", "observability", "unsafe", "env"}), "unreviewed Worker option")
    require(worker.get("unsafe") == {"metadata": {"usage_model": "standard"}}, "unexpected upload metadata")
    require(worker.get("observability") == {"enabled": False}, "observability must be off")
    require(worker.get("previewUrls") is False, "preview URLs must be disabled")
    require(worker.get("assets") == {"notFoundHandling": "single-page-application", "runWorkerFirst": ["/api/*", "/auth/*"]}, "preserve static asset routing")
    bindings = worker["env"]
    require(all(isinstance(b, dict) and b.get("type") in {"d1", "assets", "text", "secret"} for b in bindings.values()), "forbidden binding")
    require(sum(b.get("type") == "d1" for b in bindings.values()) == 1 and bindings["DB"].get("type") == "d1", "exactly one D1 database bound as DB is required")
    require(bindings["ASSETS"].get("type") == "assets", "ASSETS binding is required")
    for name in ("APP_ORIGIN", "HRTID_ISSUER", "HRTID_CLIENT_ID"):
        require(bindings[name].get("type") == "text", f"{name} must be a text binding")


def configure_deployment(config, ask=input, log=print):
    result = copy.deepcopy(config)
    validate_structure(result)
    worker = result["worker"]
    bindings = worker["env"]

    def field(question, current, valid, hint):
        fallback = current if configured(current) else ""
        while True:
            suffix = f" [{fallback}]" if fallback else ""
            answer = ask(f"{question}{suffix}: ").strip() or fallback
            if valid(answer):
                return answer
            log(hint)

    result["accountId"] = field("Cloudflare account ID", result.get("accountId"), lambda v: re.fullmatch(r"[a-fA-F0-9]{32}", v), "Enter the 32-character account ID from the Cloudflare dashboard.")
    worker["name"] = field("Worker name", worker.get("name"), lambda v: re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", v), "Use 1–63 lowercase letters, digits or hyphens; start with a letter or digit.")
    log("Free mode refuses paid Cloudflare accounts. Paid mode permits hosting charges; it does not purchase a plan.")
    result["billingMode"] = field("Hosting billing mode (free/paid)", result.get("billingMode", "free"), lambda v: v in {"free", "paid"}, "Enter free or paid.")
    bindings["DB"]["name"] = field("D1 database name", bindings["DB"].get("name"), lambda v: re.fullmatch(r"[a-zA-Z0-9_-]+", v), "Enter your D1 database name (letters, digits, hyphens or underscores).")
    log(f"Use an existing D1 database, or create one first: CLOUDFLARE_ACCOUNT_ID={result['accountId']} cf d1 create --name {bindings['DB']['name']}")
    bindings["DB"]["id"] = field("D1 database ID", bindings["DB"].get("id"), lambda v: re.fullmatch(r"[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}", v), "Enter the database UUID returned by Cloudflare.")
    hosting = field("Public address (workers.dev/custom)", "custom" if worker.get("domains") else "workers.dev", lambda v: v in {"workers.dev", "custom"}, "Enter workers.dev or custom.")
    if hosting == "workers.dev":
        old_origin = bindings["APP_ORIGIN"].get("value", "")
        try:
            old_host = (urlsplit(old_origin).hostname or "") if configured(old_origin) else ""
        except ValueError:
            old_host = ""
        current = ".".join(old_host.split(".")[1:-2]) if old_host.endswith(".workers.dev") else ""
        subdomain = field("Account workers.dev subdomain (just the subdomain)", current, label, "Enter the subdomain enabled in your Cloudflare Workers dashboard, without .workers.dev.")
        host = f"{worker['name']}.{subdomain}.workers.dev"
        worker["domains"] = []
        worker["workersDev"] = True
    else:
        host = field("Custom domain hostname", (worker.get("domains") or [None])[0], lambda v: hostname(v) and not v.endswith(".workers.dev"), "Enter a lowercase hostname such as dating.example.com, without https:// or a path.")
        worker["domains"] = [host]
        worker["workersDev"] = False
    bindings["APP_ORIGIN"]["value"] = f"https://{host}"
    log(f"Register your hrtID client with:\n  Redirect URI: https://{host}/auth/callback\n  Launch URL: https://{host}/")
    bindings["HRTID_ISSUER"]["value"] = field("hrtID issuer URL", bindings["HRTID_ISSUER"].get("value"), issuer_url, "Enter a valid HTTPS issuer URL.")
    bindings["HRTID_CLIENT_ID"]["value"] = field("hrtID public client ID", bindings["HRTID_CLIENT_ID"].get("value"), lambda v: configured(v) and not re.search(r"\s", v), "Enter your registered client ID, not a client secret.")
    log("Optional instance AI hosting sends matched chats to your model service. Model costs are separate from Cloudflare billing mode.")
    ai_mode = field("Offer instance AI hosting (yes/no)", "yes" if bindings.get("AI_ENDPOINT") else "no", lambda v: v in {"yes", "no"}, "Enter yes or no.")
    if ai_mode == "yes":
        current_endpoint = bindings.get("AI_ENDPOINT", {}).get("value")
        current_provider = "openrouter" if not current_endpoint or current_endpoint == OPENROUTER_ENDPOINT else "custom"
        provider = field("AI provider (openrouter/custom)", current_provider, lambda v: v in {"openrouter", "custom"}, "Enter openrouter or custom.")
        if provider == "openrouter":
            endpoint = OPENROUTER_ENDPOINT
            log("Choose a text chat model ID from https://openrouter.ai/models (provider/model). Create an API key at https://openrouter.ai/settings/keys.")
        else:
            endpoint = field("HTTPS chat completions endpoint (full URL)", current_endpoint if current_provider == "custom" else None, issuer_url, "Enter an HTTPS chat completions URL without credentials, query or fragment.")
        current_model = bindings.get("AI_MODEL", {}).get("value") if provider == current_provider else None
        model = field("Hosted model ID", current_model, lambda v: configured(v) and len(v) <= 200 and not re.search(r"\s", v) and (provider != "openrouter" or bool(re.fullmatch(r"[^/]+/[^/]+", v))), "Enter a model ID without spaces (provider/model for OpenRouter).")
        bindings["AI_ENDPOINT"] = {"type": "text", "value": endpoint}
        bindings["AI_MODEL"] = {"type": "text", "value": model}
        bindings["AI_API_KEY"] = {"type": "secret"}
        log("Save your model service API key as AI_API_KEY in a private JSON file outside the repository, then deploy: npm run deploy -- --secrets-file /path/to/private-secrets.json. Never put the key in this configuration or frontend code.")
    else:
        for name in ("AI_ENDPOINT", "AI_MODEL", "AI_API_KEY"):
            bindings.pop(name, None)
    return result


def main():
    target = Path(os.environ.get("DEPLOYMENT_CONFIG") or "deployment.local.json").resolve()
    template = Path("deployment.json").resolve()
    if target == template:
        raise ValueError("Choose a local configuration file; deployment.json is the shared template.")
    source = target if target.exists() else template
    config = json.loads(source.read_text(encoding="utf-8"))
    print(f"Configure Estrogen Dating → {target}\nPress Enter to keep a displayed default. Ctrl+C cancels without saving.\nThis writes configuration only; it does not create resources or deploy.")
    result = configure_deployment(config)
    temporary = None
    try:
        # Same-directory replacement is atomic; NamedTemporaryFile uses mode 0600.
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=target.parent, prefix=f".{target.name}.", suffix=".tmp", delete=False) as output:
            temporary = Path(output.name)
            json.dump(result, output, indent=2, ensure_ascii=False)
            output.write("\n")
        os.replace(temporary, target)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()
    print(f"\nSaved {target}\nOrigin: {result['worker']['env']['APP_ORIGIN']['value']}\nBilling mode: {result['billingMode']}\nNext: npm run check:deployment, then npm run deploy.")
    if os.environ.get("DEPLOYMENT_CONFIG"):
        print(f"Keep DEPLOYMENT_CONFIG set to {target} for those commands. Keep this file out of version control.")


if __name__ == "__main__":
    try:
        main()
    except (EOFError, KeyboardInterrupt):
        print("\nSetup cancelled; no configuration was written.", file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        print(f"Configuration failed: {error}", file=sys.stderr)
        sys.exit(1)
