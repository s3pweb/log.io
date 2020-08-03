FROM node:12-alpine

RUN mkdir -p /home/node/app/node_modules && chown -R node:node /home/node/app

WORKDIR /home/node/app

COPY server/package*.json ./

USER node

RUN npm install --only=prod

COPY --chown=node:node server/lib .
COPY --chown=node:node config.json /home/node/config.json

EXPOSE 6688 
EXPOSE 6689

CMD [ "node", "index.js" ]