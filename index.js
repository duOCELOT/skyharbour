import { getConfig } from "./config.js";

const nearConfig = getConfig("testnet");

const { connect, WalletConnection, Contract, utils } = nearApi;
const signInButton = document.getElementById("sign-in-button");
const signOutButton = document.getElementById("sign-out-button");
const accountP = document.getElementById("account");
const mintDiv = document.getElementById("mint");
const mintButton = document.getElementById("mint-button");
const tokenIdInput = document.getElementById("token-id");
const titleInput = document.getElementById("title");
const imageUrlInput = document.getElementById("image-url");

const nearConnection = await connect(nearConfig);
const walletConnection = new WalletConnection(nearConnection);

signInButton.onclick = () => walletConnection.requestSignIn(nearConfig.contractName);
signOutButton.onclick = () => { walletConnection.signOut(); window.location.reload(); };

mintButton.onclick = async () => {
    console.log("Minting...", tokenIdInput.value, titleInput.value, imageUrlInput.value);
    const accountId = walletConnection.getAccountId();
    const account = walletConnection.account();
    const contract = await new Contract(account, nearConfig.contractName, {
        viewMethods: [""],
        changeMethods: ["nft_mint"],
    });

    const mint = await contract.nft_mint({
        token_id: tokenIdInput.value,
        metadata: {
            title: titleInput.value,
            description: "Some description will appear here",
            media: imageUrlInput.value,
        },
        receiver_id: accountId,
    },
        300000000000000,// gas optional
        utils.format.parseNearAmount("1"));//Storage
};


window.onload = async () => {
    let isSignedIn = walletConnection.isSignedIn();
    if (isSignedIn) {
        console.log("Signed In!");
        signInButton.style.display = "none";
        let accountId = walletConnection.getAccountId();
        accountP.innerText = "Signed in as " + accountId;
        const contract = await new Contract(account, nearConfig.contractName, { 
            viewMethods: ["nft_tokens_for_owner"],
        });
        const tokens = await contract.nft_tokens_for_owner({ account_id: accountId });
        console.log("Tokens", tokens);
        let tokensDiv = document.getElementById("tokens"); 
        tokens.forEach((token) => {
            let tokenImg = document.createElement("img");
            tokenImg.src = token.metadata.media;
            tokenImg.style.width = "100px";
            tokensDiv.appendChild(tokenImg);
        });
    } else {
        console.log("Not sign in !");
        signOutButton.style.display = "none";
        mintDiv.style.display = "none";
    }
};