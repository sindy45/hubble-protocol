# bin/sh


if [ -d "venv" ] 
then
    echo "* Virtualenv exists"
else
    echo "* Creating virtualenv"
    python3 -m venv venv
fi

source venv/bin/activate

if pip freeze | grep 'vyper==0.2.16'; then
    echo "* version exists"
else
    pip install vyper==0.2.16
fi

npm run vyper-compile && npm run compile
