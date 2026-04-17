# FROM ubuntu:18.04

FROM gitpod/openvscode-server:latest
#

 # to get permissions to install packages and such
USER root

RUN sed -i 's/archive.ubuntu.com/mirrors.ustc.edu.cn/g' /etc/apt/sources.list

RUN apt-get update && apt-get install -y \
    vim zsh git g++ gdb python3 python3-pip python3-venv wget make unzip curl \
    autoconf automake autotools-dev curl libmpc-dev libmpfr-dev libgmp-dev \
    gawk build-essential bison flex texinfo gperf libtool patchutils bc xz-utils \
    zlib1g-dev libexpat-dev pkg-config  libglib2.0-dev libpixman-1-dev tmux 


#install rust and qemu
RUN set -x; \
    RUSTUP='/home/workspace/rustup.sh' \
    && cd $HOME \
    #install rust
    && curl https://sh.rustup.rs -sSf > $RUSTUP && chmod +x $RUSTUP \
    && $RUSTUP -y --default-toolchain nightly --profile minimal \
    && echo done. \
    #compile qemu
    && wget https://ftp.osuosl.org/pub/blfs/conglomeration/qemu/qemu-5.0.0.tar.xz \
    && tar xvJf qemu-5.0.0.tar.xz \
    && cd qemu-5.0.0 \
    && ./configure --target-list=riscv64-softmmu,riscv64-linux-user \
    && make -j$(nproc) install \
    && cd $HOME && rm -rf qemu-5.0.0 qemu-5.0.0.tar.xz

#for chinese network
RUN set -x; \
    APT_CONF='/etc/apt/sources.list'; \
    CARGO_CONF='/home/workspace/.cargo/config'; \
    BASHRC='/home/workspace/.bashrc' \
    && echo 'export RUSTUP_DIST_SERVER=https://mirrors.ustc.edu.cn/rust-static' >> $BASHRC \
    && echo 'export RUSTUP_UPDATE_ROOT=https://mirrors.ustc.edu.cn/rust-static/rustup' >> $BASHRC \
    && touch $CARGO_CONF \
    && echo '[source.crates-io]' > $CARGO_CONF \
    && echo "replace-with = 'ustc'" >> $CARGO_CONF \
    && echo '[source.ustc]' >> $CARGO_CONF \
    && echo 'registry = "git://mirrors.ustc.edu.cn/crates.io-index"' >> $CARGO_CONF

ENV PATH="$HOME/.cargo/bin:${PATH}"

# some rust dependencies for rCore-Tutorial
RUN rustup target add riscv64gc-unknown-none-elf
RUN cargo install cargo-binutils --vers ~0.2
RUN rustup component add rust-src
RUN rustup component add llvm-tools-preview

WORKDIR $HOME



# this archive will be automatically unzipped.
ADD ./riscv64-unknown-elf-toolchain-10.2.0-2020.12.8-x86_64-linux-ubuntu14.tar.gz /home/workspace
ADD ./gdb_startup_cmd.txt /home/workspace
ADD ./Makefile /home/workspace




# use mirror site due to annoying network
# RUN git clone https://github.com.cnpmjs.org/rcore-os/rCore-Tutorial-v3.git
RUN git clone https://hub.fastgit.xyz/chenzhiy2001/rCore-Tutorial-v3.git




RUN chown -R openvscode-server:openvscode-server /home/workspace/

# to restore permissions for the web interface
# USER openvscode-server 

# RUN python3 -m pip install --upgrade pip \
#     && pip3 install gdbgui -i https://pypi.tuna.tsinghua.edu.cn/simple
