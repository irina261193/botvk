import os
from dotenv import load_dotenv


load_dotenv()


# VK
VK_TOKEN = os.getenv("VK_TOKEN")
VK_GROUP_ID = os.getenv("VK_GROUP_ID")
VK_ADMIN_ID = os.getenv("VK_ADMIN_ID")

# Kie.ai
KIE_API_KEY = os.getenv("KIE_API_KEY")
KIE_API_URL = os.getenv("KIE_API_URL")


# Проверяем, что все необходимые настройки заполнены
required_variables = {
    "VK_TOKEN": VK_TOKEN,
    "VK_GROUP_ID": VK_GROUP_ID,
    "VK_ADMIN_ID": VK_ADMIN_ID,
    "KIE_API_KEY": KIE_API_KEY,
    "KIE_API_URL": KIE_API_URL,
}

missing_variables = [
    name
    for name, value in required_variables.items()
    if not value
]

if missing_variables:
    raise RuntimeError(
        "Не заполнены переменные окружения: "
        + ", ".join(missing_variables)
    )


# ID должны быть числами
VK_GROUP_ID = int(240515236)
VK_ADMIN_ID = int(79527736)