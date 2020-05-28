#!/bin/bash

version=0.0.1

./server/bin/build-ui.sh
docker build -t s3pweb/logio:$version .
docker push s3pweb/logio:$version