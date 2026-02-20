FROM node:lts-alpine3.19

ARG LLBOT_VERSION=7.9.0

RUN set -eux; \
    apk update; \
    apk add --no-cache tzdata ffmpeg unzip wget; \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime; \
    echo "Asia/Shanghai" > /etc/timezone; \
    rm -rf /var/cache/apk/*

WORKDIR /app/llonebot

COPY docker/llonebot-startup.sh /startup.sh
RUN chmod +x /startup.sh

RUN wget "https://github.com/LLOneBot/LuckyLilliaBot/releases/download/v${LLBOT_VERSION}/LLBot.zip" -O /app/llbot.zip
RUN unzip /app/llbot.zip -d /app/llbot && rm /app/llbot.zip

ENTRYPOINT ["/startup.sh"]
