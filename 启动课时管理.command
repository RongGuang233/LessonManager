#!/bin/zsh
cd "${0:A:h}" || exit 1
for candidate in /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
  if [[ -x "$candidate" ]]; then
    exec "$candidate" lessonmanager.py --open
  fi
done
echo "未找到 Python 3，请先安装 Python 3.10 或更新版本。"
read -r '?按回车关闭。'
