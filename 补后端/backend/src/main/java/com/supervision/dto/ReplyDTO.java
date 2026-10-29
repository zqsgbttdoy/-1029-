package com.supervision.dto;

import jakarta.validation.constraints.NotBlank;
import lombok.Data;

@Data
public class ReplyDTO {

    // id 由路径参数注入（controller 中 dto.setId(id)），无需请求体携带
    private Long id;

    @NotBlank(message = "回复内容不能为空")
    private String replyContent;

    // 整改回复附件：JSON 数组字符串，元素为 { url, name, size }，与上传接口返回结构一致
    private String attachments;

    // 整改照片：同为 JSON 数组字符串，成功回复后合并进 photos 列，供后续复核查看
    private String photos;
}
